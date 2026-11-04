import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { Worker } from "node:worker_threads";
import { createRequiredExecRuntimeContract } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  patchSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  useSessionStoreTempDirs,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { prepareCodexNativeExecutionPolicy } from "./native-execution-policy.js";

const tempDirs = useSessionStoreTempDirs(afterEach, "codex-policy-effect-");
beforeEach(() => setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } }));
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it.each(["metadata during selection", "policy revoked", "session replaced"] as const)(
  "guards real exec dispatch after %s",
  async (change) => {
    const stateDir = tempDirs.make();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:authority-chain",
      storePath: resolveStorePath(undefined, { agentId: "main" }),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: "original", updatedAt: 1, execHost: "gateway" },
    });
    await closeOpenClawAgentDatabasesAsync(stateDir);

    let publication: Promise<void> | undefined;
    // Hold delivery of the real worker snapshot until the metadata writer commits.
    // oxlint-disable-next-line typescript/unbound-method -- forwarding preserves the worker receiver.
    const emit = Worker.prototype.emit;
    const delivery = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event,
      ...args
    ) {
      const message: unknown = args[0];
      if (
        change === "metadata during selection" &&
        !publication &&
        event === "message" &&
        isRecord(message) &&
        isRecord(message.value) &&
        isRecord(message.value.value) &&
        message.value.value.kind === "session-entry-read"
      ) {
        publication = patchSessionEntry({
          ...target,
          update: () => ({ displayName: "Metadata changed" }),
          skipMaintenance: true,
        }).then(() => {
          emit.call(this, event, ...args);
        });
        return true;
      }
      return emit.call(this, event, ...args);
    });
    const command = createRequiredExecRuntimeContract();
    let policy: Awaited<ReturnType<typeof prepareCodexNativeExecutionPolicy>> | undefined;
    try {
      policy = await prepareCodexNativeExecutionPolicy({
        ...target,
        config: {},
        readRuntimeSessionEntry: true,
        sandboxAvailable: false,
      });
      await publication;
      delivery.mockRestore();
      if (change !== "metadata during selection") {
        await patchSessionEntry({
          ...target,
          update: () =>
            change === "policy revoked" ? { execHost: "node" } : { sessionId: "replacement" },
          skipMaintenance: true,
        });
      }
      const bridge = createCodexDynamicToolBridge({
        tools: [command.tool],
        signal: new AbortController().signal,
        assertCurrentAsync: policy.assertCurrent,
        loading: "direct",
      });
      // Complete the fake OS process immediately; exec preparation/dispatch stay real.
      command.finish();
      const response = await bridge.handleToolCall({
        threadId: "synthetic-thread",
        turnId: "synthetic-turn",
        callId: "synthetic-call",
        namespace: null,
        tool: "exec",
        arguments: { command: "echo authority-chain", workdir: stateDir, awaitResults: true },
      });
      if (change === "metadata during selection") {
        expect(publication).toBeDefined();
        expect(response).toMatchObject({ success: true });
        expect(command.spawn).toHaveBeenCalledOnce();
      } else {
        expect(response).toMatchObject({
          success: false,
          contentItems: [
            { type: "inputText", text: expect.stringContaining("execution policy changed") },
          ],
        });
        expect(command.spawn).not.toHaveBeenCalled();
      }
    } finally {
      delivery.mockRestore();
      policy?.release();
      command.close();
    }
  },
);
