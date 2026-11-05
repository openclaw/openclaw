import fs from "node:fs/promises";
import path from "node:path";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { createCodexAppServerBindingStore, sessionBindingIdentity } from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
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
afterEach(resetThreadLifecycleTestFixtures);

describe("native Codex cold thread recovery", () => {
  it(
    "replaces a deleted ordinary binding and completes its next turn",
    { timeout: 75_000 },
    async (context) => {
      const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
        context.onTestFinished(async () => {
          await closeOpenClawStateDatabaseAsync();
          cleanup();
        }),
      );
      const root = await fs.realpath(tempDirs.make("codex-missing-thread-"));
      const native = await createCodexNativeTestState(root);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("HOME", native.env.HOME);
      vi.stubEnv("CODEX_HOME", native.codexHome);
      let requests = 0;
      const port = await listenForNativeResponses(context, (request, response) => {
        request.resume();
        request.on("end", () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          requests += 1;
          sendNativeResponse(response, "recovered-response", {
            type: "message",
            role: "assistant",
            id: "recovered-answer",
            content: [{ type: "output_text", text: "Recovered conversation." }],
          });
        });
      });
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        nativeProviderConfig(
          "recovery-fixture",
          port,
          ['sandbox_mode="read-only"', "allow_login_shell=false"],
          ["shell_snapshot=false"],
        ),
      );
      const agentDir = path.join(root, "agent");
      const appServer = nativeAppServerOptions(native);
      const client = await createIsolatedCodexAppServerClient({
        startOptions: appServer.start,
        agentDir,
        authProfileId: null,
        config: {},
        timeoutMs: 20_000,
      });
      context.onTestFinished(async () =>
        expect(await client.closeAndWait()).toMatchObject({ exited: true }),
      );
      expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
      const params = {
        ...createParams(path.join(root, "session.jsonl"), native.cwd),
        disableTools: false,
        agentId: "main",
        agentDir,
        modelId: "gpt-5.6-luna",
      };
      const store = createCodexSqliteTestBindingStateStore({
        namespace: "native-recovery-test",
        maxEntries: 32,
        env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
      });
      const bindingStore = createCodexAppServerBindingStore(store);
      const common = {
        client,
        bindingStore,
        params,
        cwd: native.cwd,
        dynamicTools: [],
        appServer,
        userMcpServersEnabled: false,
        signal: AbortSignal.timeout(60_000),
      };
      const first = await startOrResumeThread(common);
      await client.request("thread/inject_items", {
        threadId: first.threadId,
        items: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Synthetic previous history." }],
          },
        ],
      });
      await client.request("thread/delete", { threadId: first.threadId });
      await expect(
        client.request("thread/read", { threadId: first.threadId, includeTurns: false }),
      ).rejects.toMatchObject({ code: -32_600 });
      const identity = sessionBindingIdentity(params);
      expect(bindingStore.read(identity)?.threadId).toBe(first.threadId);
      const recovered = await startOrResumeThread(common);
      expect(recovered.threadId).not.toBe(first.threadId);
      expect(recovered).toMatchObject({
        model: "gpt-5.6-luna",
        modelProvider: "recovery-fixture",
        lifecycle: { action: "started" },
      });
      expect(bindingStore.read(identity)?.threadId).toBe(recovered.threadId);
      await expect(
        runNativeTurn(client, recovered.threadId, "Continue the conversation."),
      ).resolves.toMatchObject({ status: "completed" });
      expect(requests).toBe(1);
      const history = await client.request("thread/read", {
        threadId: recovered.threadId,
        includeTurns: true,
      });
      expect(JSON.stringify(history.thread.turns)).toContain("Recovered conversation.");
    },
  );
});
