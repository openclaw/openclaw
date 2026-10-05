import path from "node:path";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import manifest from "../../openclaw.plugin.json" with { type: "json" };
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { createParams, setupRunAttemptTestHooks, tempDir } from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { getLeasedSharedCodexAppServerClient } from "./shared-client.js";

setupRunAttemptTestHooks();

describe("worker-hosted Codex attempt", () => {
  it("admits the worker-hosted setting through the published plugin schema", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      value: { appServer: { transport: "stdio", homeScope: "agent", workerHostedCloud: true } },
    });
    expect(result.ok).toBe(true);
  });

  it("keeps an ordinary Gateway session on the local native Codex owner", async () => {
    const sessionFile = path.join(tempDir, "gateway-native-command.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "gateway-native-command"));
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
    const connection = await prepareCodexAttemptConnection({
      params,
      options: {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: { appServer: { workerHostedCloud: true } },
      },
    });
    try {
      expect(connection.attemptClientFactory).toBe(getLeasedSharedCodexAppServerClient);
      expect(connection.callerOwnedAttemptClient).toBe(false);
      expect(connection.startupPreparedAuth).toBeUndefined();
    } finally {
      connection.cancellation.dispose();
      connection.releaseModelExecution();
    }
  });

  it("reports failed placement without launching Gateway Codex", async () => {
    vi.stubEnv("FACTORY_WORKER_LLM_CONFIG_VERSION", "a".repeat(64));
    const sessionFile = path.join(tempDir, "worker-placement-failure.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "worker-placement-failure"));
    const sandbox = {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec",
      placementNodeId: "worker-node",
      placementEnvironmentId: "worker-environment",
      placementSessionId: params.sessionId,
      placementOwnerEpoch: 1,
    } as NonNullable<typeof params.sandbox>;
    params.sandbox = sandbox;
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
    const openDuplex = vi.fn(async () => {
      throw new Error("placement unavailable");
    });
    const connection = await prepareCodexAttemptConnection({
      params,
      options: {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: { appServer: { workerHostedCloud: true } },
        runtime: { nodes: { openDuplex } } as unknown as PluginRuntime,
      },
    });
    try {
      expect(connection.callerOwnedAttemptClient).toBe(true);
      expect(connection.startupPreparedAuth).toBeUndefined();
      expect(connection.effectiveCwd).toBe(sandbox.containerWorkdir);
      await expect(
        connection.attemptClientFactory({
          abandonSignal: new AbortController().signal,
        }),
      ).rejects.toThrow("placement unavailable");
      expect(openDuplex).toHaveBeenCalledOnce();
    } finally {
      connection.cancellation.dispose();
      connection.releaseModelExecution();
      vi.unstubAllEnvs();
    }
  });
});
