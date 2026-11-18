import type { CodexNativeSubagentBindingMutation } from "./session-binding-native-mutations.js";
import type {
  CodexAppServerThreadBinding,
  CodexAppServerPendingSupervisionBranch,
} from "./session-binding-record.js";

export type CodexAppServerBindingMutation =
  | CodexNativeSubagentBindingMutation
  | {
      kind: "set";
      binding: CodexAppServerThreadBinding;
      if?: { kind: "absent" };
    }
  | {
      kind: "patch";
      threadId: string;
      clientId?: string;
      patch: Partial<Omit<CodexAppServerThreadBinding, "threadId">>;
    }
  | {
      kind: "replace-thread";
      expectedThreadId: string;
      expectedBinding?: CodexAppServerThreadBinding;
      binding: CodexAppServerThreadBinding;
    }
  | {
      kind: "patch-pending-supervision-branch";
      expected: CodexAppServerPendingSupervisionBranch;
      pending: CodexAppServerPendingSupervisionBranch;
    }
  | {
      kind: "commit-pending-supervision-branch";
      expected: CodexAppServerPendingSupervisionBranch;
      threadId: string;
      patch: Partial<Omit<CodexAppServerThreadBinding, "threadId" | "pendingSupervisionBranch">>;
    }
  | {
      kind: "reclaim-generation";
      expectedPreviousSessionId: string;
    }
  | {
      kind: "clear";
      threadId?: string;
      clientId?: string;
    };
