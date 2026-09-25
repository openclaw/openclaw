import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock, createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, vi } from "vitest";
import { resolveFeishuMediaList } from "./bot-content.js";
import { handleFeishuMessage } from "./bot.js";
import {
  createFeishuTestConfig,
  createFeishuTestEvent,
  createFeishuTestRoute,
} from "./bot.test-support.js";
import { feishuDedupeState } from "./dedup-state.js";
import { setFeishuRuntime } from "./runtime.js";

// This proof stops at the Gateway's agent-dispatch boundary. The Feishu event
// handler, parser, SDK token exchange, resource download and file writes are real.
vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: () => ({
    dispatcherOptions: {},
    delivery: { deliver: async () => ({ visibleReplySent: false }) },
    replyOptions: {},
    ensureNoVisibleReplyFallback: async () => false,
  }),
}));

it("delivers post files to agent context over real SDK HTTP without changing standalone files", async () => {
  const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
    pluginId: "feishu",
    errorMessage: "Feishu runtime not initialized",
  });
  const previousRuntime = runtimeStore.tryGetRuntime();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-post-files-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const resources = new Map([
    [
      "file_report",
      { name: "report.csv", type: "text/csv", bytes: Buffer.from("item,total\nalpha,42\n") },
    ],
    [
      "file_notes",
      { name: "notes.txt", type: "text/plain", bytes: Buffer.from("Notes from the attachment.\n") },
    ],
    [
      "file_clip",
      {
        name: "clip.mp4",
        type: "video/mp4",
        bytes: Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex"),
      },
    ],
  ]);
  const requests: Array<{ path: string; type: string | null; authorization: string | undefined }> =
    [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const record = {
      path: url.pathname,
      type: url.searchParams.get("type"),
      authorization: request.headers.authorization,
    };
    requests.push(record);
    request.resume();
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ code: 0, tenant_access_token: "post-files-fixture-token", expire: 7200 }),
      );
      return;
    }
    const key = url.pathname.split("/").at(-1) ?? "";
    const resource = resources.get(key);
    if (
      !resource ||
      !url.pathname.includes("/resources/") ||
      record.authorization !== "Bearer post-files-fixture-token"
    ) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 404, msg: "unexpected fixture request" }));
      return;
    }
    response.writeHead(200, {
      "content-type": resource.type,
      "content-disposition": `attachment; filename="${resource.name}"`,
      "content-length": resource.bytes.length,
    });
    response.end(resource.bytes);
  });
  let interceptor: number | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("loopback server did not bind a TCP port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    // Match the existing Feishu SDK transport proof: a custom domain with a
    // port is interpreted as an API path parameter by the SDK URL formatter.
    interceptor = Lark.defaultHttpInstance.interceptors.request.use(
      (options) => {
        const upstream = new URL(options.url ?? "");
        if (upstream.hostname !== "open.feishu.cn") {
          throw new Error("unexpected external destination in loopback proof");
        }
        options.url = new URL(`${upstream.pathname}${upstream.search}`, origin).toString();
        options.proxy = false;
        return options;
      },
      undefined,
      { synchronous: true },
    );
    const cfg = createFeishuTestConfig(
      {
        enabled: true,
        appId: `cli_post_files_${path.basename(stateDir)}`,
        appSecret: "loopback-placeholder", // pragma: allowlist secret
        dmPolicy: "open",
        allowFrom: ["*"],
        resolveSenderNames: false,
      },
      { session: { mainKey: "main", scope: "per-sender" } },
    );
    type Context = Parameters<
      ReturnType<
        typeof createPluginRuntimeMock
      >["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
    >[0]["ctx"];
    const contexts: Context[] = [];
    const runtime = createPluginRuntimeMock({
      config: { current: () => cfg },
      channel: {
        routing: { resolveAgentRoute: () => createFeishuTestRoute({ matchedBy: "binding.peer" }) },
        inbound: { buildContext: buildChannelInboundEventContext },
        commands: { shouldComputeCommandAuthorized: () => false },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }) => {
            contexts.push(ctx);
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          },
        },
      },
    });
    setFeishuRuntime(runtime);
    const env = createRuntimeEnv();
    const runMessage = async (messageId: string, messageType: string, content: unknown) => {
      const before = contexts.length;
      await handleFeishuMessage({
        cfg,
        runtime: env,
        event: createFeishuTestEvent({
          messageId,
          messageType,
          senderOpenId: "ou_post_files",
          content: JSON.stringify(content),
        }),
      });
      expect(contexts.length, `agent dispatch for ${messageId}`).toBe(before + 1);
      const context = contexts.at(-1);
      if (!context) {
        throw new Error("missing agent context");
      }
      return context;
    };
    const checkBytes = async (context: Context, keys: string[]) => {
      expect(context.media, `attachments for ${context.MessageSid}`).toHaveLength(keys.length);
      expect(context.media?.map((media) => media.kind)).toEqual(
        keys.map((key) => (key === "file_clip" ? "video" : "document")),
      );
      for (const [index, key] of keys.entries()) {
        const file = context.media?.[index]?.path;
        const resource = resources.get(key);
        if (!file || !resource) {
          throw new Error("missing downloaded file or fixture");
        }
        expect(path.relative(stateDir, file).startsWith("..")).toBe(false);
        expect(await fs.readFile(file)).toEqual(resource.bytes);
      }
      console.info(JSON.stringify({ message: context.MessageSid, verifiedFiles: keys.length }));
    };
    // A healthy standalone download demonstrates the SDK/server contract
    // independently of the rich-post parser under test.
    await checkBytes(
      await runMessage("om_control", "file", { file_key: "file_report", file_name: "report.csv" }),
      ["file_report"],
    );
    const captioned = await runMessage("om_captioned", "post", {
      content: [[{ tag: "text", text: "Compare the attached report" }]],
      files: [{ file_key: "file_report", file_name: "report.csv", is_folder: false }],
    });
    expect(captioned.BodyForAgent).toContain("Compare the attached report");
    await checkBytes(captioned, ["file_report"]);
    const beforeMixed = requests.length;
    const mixed = await runMessage("om_mixed", "post", {
      content: [[{ tag: "media", file_key: "file_clip", file_name: "clip.mp4" }]],
      files: [
        { file_key: "file_clip", file_name: "clip.mp4" },
        { file_key: "file_report", file_name: "report.csv" },
        { file_key: "file_notes", file_name: "notes.txt" },
        { file_key: "file_notes", file_name: "notes.txt" },
        { file_key: "file_folder", is_folder: true },
        { file_key: "invalid/key" },
      ],
    });
    await checkBytes(mixed, ["file_clip", "file_report", "file_notes"]);
    expect(
      requests.slice(beforeMixed).filter((request) => request.path.includes("/resources/")),
    ).toHaveLength(3);
    await checkBytes(
      await runMessage("om_files_only", "post", {
        content: [[]],
        files: [{ file_key: "file_report" }, { file_key: "file_notes" }],
      }),
      ["file_report", "file_notes"],
    );
    const limited = await resolveFeishuMediaList({
      cfg,
      messageId: "om_limit",
      messageType: "post",
      content: JSON.stringify({ content: [[]], files: [{ file_key: "file_report" }] }),
      maxBytes: 1,
    });
    expect(limited).toEqual([{ kind: "document" }]);
    expect(
      requests
        .filter((request) => request.path.includes("/resources/"))
        .every((request) => request.type === "file"),
    ).toBe(true);
    expect(env.error).not.toHaveBeenCalled();
  } finally {
    if (interceptor !== undefined) {
      Lark.defaultHttpInstance.interceptors.request.eject(interceptor);
    }
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await closeOpenClawStateDatabaseAsync();
    feishuDedupeState.reset();
    resetPluginStateStoreForTests();
    if (previousRuntime) {
      runtimeStore.setRuntime(previousRuntime);
    } else {
      runtimeStore.clearRuntime();
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
