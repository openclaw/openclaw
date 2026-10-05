import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import {
  enumerateConversationKeyForms,
  type IMessageApprovalConversationKey,
} from "./approval-target-keys.js";

type BindingWindow = {
  done: Promise<void>;
  close: () => void;
};

const pendingByConversation = new Map<string, Set<BindingWindow>>();

function approvalControlBindingAbortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error("iMessage approval control binding aborted", { cause: reason });
}

function bindingKeys(accountId: string, conversation: IMessageApprovalConversationKey): string[] {
  const account = accountId.trim();
  return account
    ? enumerateConversationKeyForms(conversation).map((form) => `${account}:${form}`)
    : [];
}

/** Marks the send-to-binding interval during which a visible control is not yet resolvable. */
function beginIMessageApprovalControlBinding(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
}): { close: () => void } {
  const keys = bindingKeys(params.accountId, params.conversation);
  const { promise, resolve } = createDeferred<void>();
  let closed = false;
  const window: BindingWindow = {
    done: promise,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const key of keys) {
        const windows = pendingByConversation.get(key);
        windows?.delete(window);
        if (windows?.size === 0) {
          pendingByConversation.delete(key);
        }
      }
      resolve();
    },
  };
  for (const key of keys) {
    const windows = pendingByConversation.get(key) ?? new Set<BindingWindow>();
    windows.add(window);
    pendingByConversation.set(key, windows);
  }
  return { close: window.close };
}

/** Waits for one matching delivery to finish binding; callers recheck until none remain. */
async function waitForIMessageApprovalControlBinding(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  const windows = new Set<BindingWindow>();
  for (const key of bindingKeys(params.accountId, params.conversation)) {
    for (const window of pendingByConversation.get(key) ?? []) {
      windows.add(window);
    }
  }
  if (windows.size === 0) {
    return false;
  }
  if (params.abortSignal?.aborted) {
    throw approvalControlBindingAbortError(params.abortSignal);
  }
  await racePromiseWithAbortSignal(
    Promise.race([...windows].map((window) => window.done)),
    params.abortSignal,
    approvalControlBindingAbortError,
  );
  return true;
}

function clearIMessageApprovalControlBindingsForTest(): void {
  for (const windows of pendingByConversation.values()) {
    for (const window of windows) {
      window.close();
    }
  }
  pendingByConversation.clear();
}

export const iMessageApprovalControlBindings = {
  begin: beginIMessageApprovalControlBinding,
  wait: waitForIMessageApprovalControlBinding,
  clearForTest: clearIMessageApprovalControlBindingsForTest,
};
