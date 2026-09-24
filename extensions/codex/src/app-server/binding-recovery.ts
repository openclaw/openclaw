import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { assertCodexBindingMayBeReplaced } from "./session-binding.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
} from "./session-binding.js";

type PhysicalThreadOwner = {
  threadId: string;
  clientId?: string;
};

export async function clearCodexBindingForPhysicalClient(params: {
  bindingStore: CodexAppServerBindingStore;
  bindingIdentity: CodexAppServerBindingIdentity;
  thread: PhysicalThreadOwner;
  assertCurrent: () => void;
}): Promise<boolean> {
  if (!params.thread.clientId) {
    return false;
  }
  return await params.bindingStore.mutate(
    params.bindingIdentity,
    {
      kind: "clear",
      threadId: params.thread.threadId,
      clientId: params.thread.clientId,
    },
    params.assertCurrent,
  );
}

export async function clearCodexBindingAfterContextOverflow(params: {
  bindingStore: CodexAppServerBindingStore;
  bindingIdentity: CodexAppServerBindingIdentity;
  thread: PhysicalThreadOwner;
  turnId: string;
  error?: unknown;
  assertCurrent: () => void;
}): Promise<void> {
  embeddedAgentLog.warn(
    "codex app-server context-engine turn overflowed after resume; clearing thread binding for recovery",
    {
      threadId: params.thread.threadId,
      turnId: params.turnId,
      error: params.error,
    },
  );
  await clearCodexBindingForPhysicalClient(params);
}

export function canClearCodexBindingForRecovery(params: {
  expectedSessionRuntimeOwnership?: unknown;
  thread: CodexAppServerThreadBinding;
  operation: string;
}): boolean {
  if (params.expectedSessionRuntimeOwnership) {
    embeddedAgentLog.warn(
      "codex app-server preserved native binding instead of recovery rotation",
      {
        threadId: params.thread.threadId,
        operation: params.operation,
      },
    );
    return false;
  }
  assertCodexBindingMayBeReplaced(params.thread, params.operation);
  return true;
}
