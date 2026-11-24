import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import {
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import {
  listenForNativeResponses,
  nativeAppServerOptions,
  nativeProviderConfig,
  sendNativeResponse,
} from "./thread-native.test-support.js";
import { buildThreadStartParams } from "./thread-requests.js";
import { buildTurnStartParams } from "./turn-params.js";

vi.unmock("node:child_process");
afterEach(resetThreadLifecycleTestFixtures);

it.for([
  { name: "supported", modelId: "gpt-6.1-sol", config: undefined, updates: true },
  { name: "unsupported", modelId: "gpt-5.6-luna", config: undefined, updates: false },
  {
    name: "explicitly disabled",
    modelId: "gpt-6.1-sol",
    config: { "features.reasoning_effort_override": false },
    updates: false,
  },
])(
  "preserves native effort semantics for $name models",
  { timeout: 60_000 },
  async ({ modelId, config, updates }, context) => {
    const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
      context.onTestFinished(async () => {
        await closeOpenClawStateDatabaseAsync();
        cleanup();
      }),
    );
    const native = await createCodexNativeTestState(
      await fs.realpath(tempDirs.make("codex-effort-")),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(native.cwd, "state"));
    vi.stubEnv("HOME", native.env.HOME);
    vi.stubEnv("CODEX_HOME", native.codexHome);
    const requests: JsonObject[] = [];
    const port = await listenForNativeResponses(context, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!isJsonObject(body)) {
          response.writeHead(400).end();
          return;
        }
        requests.push(body);
        sendNativeResponse(response, `resp-${requests.length}`, {
          type: "message",
          role: "assistant",
          id: `answer-${requests.length}`,
          content: [{ type: "output_text", text: "Synthetic answer." }],
        });
      });
    });
    await fs.writeFile(
      path.join(native.codexHome, "config.toml"),
      nativeProviderConfig(
        "effort-fixture",
        port,
        ['sandbox_mode="read-only"', "allow_login_shell=false"],
        ["shell_snapshot=false"],
      ).replace('name="Synthetic effort-fixture provider"', 'name="OpenAI"'),
    );
    const appServer = nativeAppServerOptions(native);
    const client = await CodexAppServerClient.start(appServer.start);
    context.onTestFinished(async () =>
      expect(await client.closeAndWait()).toMatchObject({ exited: true }),
    );
    await client.initialize();
    const params = {
      ...createParams(path.join(native.cwd, "session.jsonl"), native.cwd),
      modelId,
      provider: "codex",
      disableTools: true,
    };
    const start = await buildThreadStartParams(params, {
      appServer,
      cwd: native.cwd,
      dynamicTools: [],
      nativeCodeModeEnabled: false,
      config,
    });
    const { thread } = await client.request("thread/start", start);
    for (const [index, thinkLevel] of (["low", "high", "medium"] as const).entries()) {
      const completed = createDeferred<unknown>();
      const remove = client.addNotificationHandler(({ method, params: notification }) => {
        if (
          method === "turn/completed" &&
          isJsonObject(notification) &&
          notification.threadId === thread.id
        ) {
          completed.resolve(notification.turn);
        }
      });
      try {
        await client.request(
          "turn/start",
          await buildTurnStartParams(
            { ...params, thinkLevel },
            {
              appServer,
              threadId: thread.id,
              cwd: native.cwd,
              promptText: `Synthetic turn ${index + 1}`,
            },
          ),
        );
        await expect(completed.promise).resolves.toMatchObject({ status: "completed" });
      } finally {
        remove();
      }
    }
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.reasoning)).toEqual([
      expect.objectContaining({ effort: "low" }),
      expect.objectContaining({ effort: updates ? "low" : "high" }),
      expect.objectContaining({ effort: updates ? "low" : "medium" }),
    ]);
    const inputs = requests.map((request) => {
      expect(Array.isArray(request.input)).toBe(true);
      return Array.isArray(request.input) ? request.input : [];
    });
    expect(inputs[1]?.slice(0, inputs[0]?.length)).toEqual(inputs[0]);
    expect(inputs[2]?.slice(0, inputs[1]?.length)).toEqual(inputs[1]);
    expect(
      inputs[2]?.filter((item) => isJsonObject(item) && item.type === "configuration_update"),
    ).toEqual(
      updates
        ? [
            { type: "configuration_update", reasoning: { effort: "low" } },
            { type: "configuration_update", reasoning: { effort: "high" } },
            { type: "configuration_update", reasoning: { effort: "medium" } },
          ]
        : [],
    );
  },
);
