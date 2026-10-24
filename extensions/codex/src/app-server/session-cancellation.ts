import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { NativeDescendantCancellationResult } from "./native-subagent-monitor-types.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";

/** Stop owns admitted descendants, without retiring the session or its native history. */
export async function withCodexSessionDescendantCancellation<T>(
  bindingStore: CodexAppServerBindingStore,
  params: Parameters<NonNullable<AgentHarness["withDescendantCancellation"]>>[0],
  run: (cancel: () => Promise<NativeDescendantCancellationResult>) => Promise<T>,
): Promise<T> {
  const identity = {
    kind: "session" as const,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  };
  params.assertCurrent();
  const binding = await bindingStore.readAsync(identity);
  params.assertCurrent();
  if (!binding?.clientId) {
    return run(async () => ({ killed: 0, cancelledRequesters: [] }));
  }
  const prepared = await bindingStore.prepareRead(identity);
  if (!prepared) {
    throw new Error("Codex descendant cancellation binding reader is unavailable");
  }
  using reader = { read: prepared.read, [Symbol.dispose]: prepared.release };
  const lease = await retainSharedCodexAppServerClientByInstanceId(binding.clientId, {
    waitForExit: false,
  });
  const assertBindingCurrent = () => {
    const current = reader.read();
    if (!current || !isSameCodexAppServerThreadOwner(current, binding)) {
      throw new Error("Codex descendant cancellation binding changed");
    }
  };
  try {
    params.assertCurrent();
    assertBindingCurrent();
    if (!lease) {
      return run(async () => ({ killed: 0, cancelledRequesters: [] }));
    }
    return await codexNativeSubagentMonitorRuntime.withDescendantCancellation(
      lease.client,
      { ...params, parentThreadId: binding.threadId, assertBindingCurrent },
      run,
    );
  } finally {
    await lease?.release();
  }
}
