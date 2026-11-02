import fs from "node:fs/promises";
import path from "node:path";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { recordCodexTurnForkSettings } from "./client-fork-settings.js";
import { CodexAppServerClient } from "./client.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject } from "./protocol.js";
import { createCodexAppServerBindingStore, sessionBindingIdentity } from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { CodexSideQuestionFork } from "./side-question-fork.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import {
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import {
  listenForNativeResponses,
  nativeAppServerOptions,
  nativeProviderConfig,
  runNativeTurn,
  sendNativeResponse,
} from "./thread-native.test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");
afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it(
  "keeps the effective resumed base in a stock native side-question fork",
  { timeout: 60_000 },
  async (context) => {
    const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
      context.onTestFinished(async () => {
        await closeOpenClawStateDatabaseAsync();
        cleanup();
      }),
    );
    const root = await fs.realpath(tempDirs.make("codex-fork-base-native-"));
    const native = await createCodexNativeTestState(root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("HOME", native.env.HOME);
    vi.stubEnv("CODEX_HOME", native.codexHome);
    const requests: string[][] = [];
    const port = await listenForNativeResponses(context, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!isJsonObject(body)) {
          throw new Error("Expected a native Responses request");
        }
        // Codex 0.164 renders base instructions as the leading developer message.
        const developerTexts = Array.isArray(body.input)
          ? body.input
              .filter(isJsonObject)
              .filter((item) => item.type === "message" && item.role === "developer")
              .flatMap((item) =>
                Array.isArray(item.content)
                  ? item.content
                      .filter(isJsonObject)
                      .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
                  : [],
              )
          : [];
        requests.push(developerTexts);
        sendNativeResponse(response, "fork-base-response-" + requests.length, {
          type: "message",
          role: "assistant",
          id: "fork-base-answer-" + requests.length,
          content: [{ type: "output_text", text: "SYNTHETIC_FORK_OK" }],
        });
      });
    });
    await fs.writeFile(
      path.join(native.codexHome, "config.toml"),
      nativeProviderConfig(
        "fork-base-proof",
        port,
        ['sandbox_mode="read-only"', "allow_login_shell=false"],
        ["shell_snapshot=false"],
      ),
    );
    const appServer = { ...nativeAppServerOptions(native), sandbox: "read-only" as const };
    const old = await CodexAppServerClient.start(appServer.start);
    context.onTestFinished(async () => {
      await old.closeAndWait();
    });
    await old.initialize();
    expect(old.getServerVersion()).toBe(CODEX_APP_SERVER_VERSION);
    const params = {
      ...createParams(path.join(root, "session.jsonl"), native.cwd),
      agentId: "main",
      agentDir: path.join(root, "agent"),
      modelId: "gpt-5.6-luna",
      disableTools: false,
    };
    const bindingStore = createCodexAppServerBindingStore(createCodexTestBindingStateStore());
    const common = {
      bindingStore,
      params,
      cwd: native.cwd,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
    };
    const initial = await startOrResumeThread({
      ...common,
      client: old,
      params: { ...params, promptMode: "none" },
    });
    await expect(
      runNativeTurn(old, initial.threadId, "Seed the old conversation."),
    ).resolves.toMatchObject({ status: "completed" });
    const oldBase = requests[0]![0]!;
    expect(await old.closeAndWait()).toMatchObject({ exited: true });
    const client = await createIsolatedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: params.agentDir,
      authProfileId: null,
      config: {},
      timeoutMs: 20_000,
    });
    context.onTestFinished(async () => {
      await client.closeAndWait();
    });
    const requestSpy = vi.spyOn(client, "request");
    const resumed = await startOrResumeThread({ ...common, client });
    expect(resumed.threadId).toBe(initial.threadId);
    expect(resumed.lifecycle?.action).toBe("resumed");
    await expect(
      runNativeTurn(client, resumed.threadId, "Continue on the current build."),
    ).resolves.toMatchObject({ status: "completed" });
    const parentBase = requests.at(-1)?.[0];
    expect(parentBase).toContain("You are a personal assistant running inside OpenClaw.");
    const resumeRequest = requestSpy.mock.calls.find(([method]) => method === "thread/resume")?.[1];
    const newBase = isJsonObject(resumeRequest) ? resumeRequest.baseInstructions : undefined;
    expect(typeof newBase).toBe("string");
    expect(newBase).not.toBe(oldBase);
    const parentHasCurrentBase = requests[1]!.some(
      (text) => typeof newBase === "string" && text.includes(newBase),
    );
    expect(parentHasCurrentBase).toBe(true);
    recordCodexTurnForkSettings(client, { threadId: resumed.threadId, input: [] });
    const fork = new CodexSideQuestionFork(client, resumed.threadId);
    const child = await client.request("thread/fork", fork.threadParams(undefined));
    await expect(
      runNativeTurn(client, child.thread.id, "Review the same conversation."),
    ).resolves.toMatchObject({ status: "completed" });
    const childBase = requests.at(-1)?.[0];
    const rollout = await fs.readFile(
      bindingStore.read(sessionBindingIdentity(params))!.rolloutPath!,
      "utf8",
    );
    const meta: unknown = JSON.parse(rollout.split("\n")[0]!);
    console.info(
      JSON.stringify({
        codexVersion: CODEX_APP_SERVER_VERSION,
        persistedCreationBaseStillOld:
          isJsonObject(meta) &&
          isJsonObject(meta.payload) &&
          isJsonObject(meta.payload.base_instructions) &&
          meta.payload.base_instructions.text === oldBase,
        parentHasCurrentBase,
        childHasCurrentBase: requests[2]!.some(
          (text) => typeof newBase === "string" && text.includes(newBase),
        ),
        developerHistoryMatchesParent:
          JSON.stringify(requests[2]!) === JSON.stringify(requests[1]!),
        creationPrefixMatchesParent: childBase === parentBase,
      }),
    );
    expect(requests).toHaveLength(3);
    expect(childBase === parentBase, "native parent/fork base parity").toBe(true);
    expect(
      JSON.stringify(requests[2]!) === JSON.stringify(requests[1]!),
      "native fork must not restore old base instructions",
    ).toBe(true);
  },
);
