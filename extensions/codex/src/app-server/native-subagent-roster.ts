import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { NativeSubagentsSnapshot } from "./native-subagent-monitor-types.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";

type NativeSubagentsReadParams = Parameters<NonNullable<AgentHarness["readNativeSubagents"]>>[0];

/** Reads only a current binding's already retained monitor; unavailable owners stay unavailable. */
export async function readCodexNativeSubagents(
  params: NativeSubagentsReadParams,
  options: { bindingStore: CodexAppServerBindingStore },
) {
  params.assertCurrent();
  const identity = sessionBindingIdentity(params);
  const binding = await options.bindingStore.readAsync(identity);
  params.assertCurrent();
  if (!binding?.clientId) {
    return undefined;
  }
  const historyOwner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: binding.threadId,
    sessionId: params.sessionId,
    lifecycleRevision: params.lifecycleRevision,
    binding,
  });
  if (!historyOwner || !matchesCodexNativeSubagentSubmissionBinding(binding, historyOwner)) {
    return undefined;
  }
  const reader = await options.bindingStore.prepareRead(identity);
  try {
    params.assertCurrent();
    if (!reader) {
      return undefined;
    }
    const assertCurrent = () => {
      params.assertCurrent();
      const current = reader.read();
      if (
        current?.clientId !== binding.clientId ||
        !current ||
        !matchesCodexNativeSubagentSubmissionBinding(current, historyOwner)
      ) {
        throw new Error("Codex native subagent observation binding changed");
      }
    };
    assertCurrent();
    const retained = await retainSharedCodexAppServerClientByInstanceId(binding.clientId, {
      waitForExit: false,
    });
    let snapshot: NativeSubagentsSnapshot;
    try {
      assertCurrent();
      if (retained) {
        snapshot = codexNativeSubagentMonitorRuntime.readNativeSubagents({
          ...params,
          client: retained.client,
          parentThreadId: binding.threadId,
          historyOwner,
          assertCurrent,
        });
      }
    } finally {
      await retained?.release();
    }
    assertCurrent();
    return snapshot;
  } finally {
    reader?.release();
  }
}
