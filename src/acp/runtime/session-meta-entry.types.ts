import type { SessionEntryReplacementPublication } from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AcpSessionControlBinding } from "./session-control-owner.js";
import type { AcpSessionEntryExpectation } from "./session-meta-entry.kernel.js";

export type AcpSessionEntryMutationInput = {
  agentId: string;
  sessionKey: string;
  mutation: AcpSessionEntryMutation;
  expectedEntry: AcpSessionEntryExpectation;
  expectedControlBinding?: AcpSessionControlBinding;
};

export type AcpSessionEntryMutation =
  | { kind: "touch"; updatedAt: number; fallbackEntry: SessionEntry }
  | { kind: "clear" }
  | { kind: "clear-legacy" };

export type AcpSessionEntryMutationResult = {
  entry: SessionEntry | null;
  publication?: SessionEntryReplacementPublication;
};
