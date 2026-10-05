import fs from "node:fs/promises";
import path from "node:path";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import type { CodexDynamicToolSpec } from "./protocol.js";
import { createCodexAppServerBindingStore, sessionBindingIdentity } from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { startOrResumeThread } from "./thread-lifecycle.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");
afterEach(resetThreadLifecycleTestFixtures);

function dynamicTools(deferLoading: boolean): CodexDynamicToolSpec[] {
  return [
    {
      type: "namespace",
      name: "openclaw",
      description: "Rotation test tools",
      tools: [
        {
          type: "function",
          name: "message",
          description: "Test message",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          deferLoading,
        },
      ],
    },
  ];
}

describe("native Codex binding rotation diagnostics", () => {
  it(
    "names a loading-mode change on a failed commit and preserves the real predecessor",
    { timeout: 75_000 },
    async (context) => {
      const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
        context.onTestFinished(async () => {
          await closeOpenClawStateDatabaseAsync();
          cleanup();
        }),
      );
      const root = await fs.realpath(tempDirs.make("codex-rotation-cause-"));
      const native = await createCodexNativeTestState(root);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("HOME", native.env.HOME);
      vi.stubEnv("CODEX_HOME", native.codexHome);
      // No login or inference is needed to create a native thread. Any accidental
      // provider request fails on loopback; no operator credentials are inherited.
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          'model="gpt-5.6-luna"',
          'model_provider="rotation-fixture"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          'sandbox_mode="read-only"',
          "allow_login_shell=false",
          "[features]",
          "shell_snapshot=false",
          "[analytics]",
          "enabled=false",
          "[feedback]",
          "enabled=false",
          "[model_providers.rotation-fixture]",
          'name="No-inference rotation fixture"',
          'base_url="http://127.0.0.1:9/v1"',
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=false",
          "request_max_retries=0",
          "stream_max_retries=0",
        ].join("\n"),
      );
      const childEnv = Object.fromEntries(
        Object.entries(native.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const appServer = {
        ...createAppServerOptions(),
        start: {
          transport: "stdio" as const,
          command: native.command,
          commandSource: "config" as const,
          args: ["app-server"],
          cwd: native.cwd,
          headers: {},
          env: childEnv,
          clearEnv: Object.keys(process.env).filter((key) => !(key in childEnv)),
        },
      };
      const agentDir = path.join(root, "agent");
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
        agentId: "main",
        agentDir,
        modelId: "gpt-5.6-luna",
        disableTools: false,
      };
      const store = createCodexSqliteTestBindingStateStore({
        namespace: "native-rotation-cause-test",
        maxEntries: 32,
        env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
      });
      const bindingStore = createCodexAppServerBindingStore(store);
      const common = {
        client,
        bindingStore,
        params,
        cwd: native.cwd,
        dynamicTools: dynamicTools(false),
        appServer,
        userMcpServersEnabled: false,
        signal: AbortSignal.timeout(60_000),
      };
      const first = await startOrResumeThread(common);
      const identity = sessionBindingIdentity(params);
      const before = bindingStore.read(identity);
      expect(before).toMatchObject({
        threadId: first.threadId,
        dynamicToolsContainDeferred: false,
      });
      const request = vi.spyOn(client, "request");
      // Fault-inject only the commit result. Both native threads and the original
      // durable binding are created by the production lifecycle, not hand-written.
      const mutate = bindingStore.mutate.bind(bindingStore);
      const mutation = vi
        .spyOn(bindingStore, "mutate")
        .mockImplementation((targetIdentity, change, assertCurrent) =>
          change.kind === "replace-thread"
            ? Promise.resolve(false)
            : mutate(targetIdentity, change, assertCurrent),
        );
      await expect(
        startOrResumeThread({
          ...common,
          dynamicTools: dynamicTools(true),
        }),
      ).rejects.toThrow(
        `Codex thread binding changed while changing its dynamic tool loading mode: ${first.threadId}`,
      );
      expect(bindingStore.read(identity)).toEqual(before);
      expect(mutation).toHaveBeenCalledWith(
        identity,
        expect.objectContaining({
          kind: "replace-thread",
          expectedThreadId: first.threadId,
        }),
        expect.any(Function),
      );
      const deletion = request.mock.calls.find(([method]) => method === "thread/delete")?.[1];
      expect(deletion).toEqual({ threadId: expect.any(String) });
      expect(deletion).not.toEqual({ threadId: first.threadId });
      expect(request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
      const preserved = await client.request("thread/read", {
        threadId: first.threadId,
        includeTurns: false,
      });
      expect(preserved.thread.id).toBe(first.threadId);
      await expect(fs.stat(path.join(native.codexHome, "auth.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
