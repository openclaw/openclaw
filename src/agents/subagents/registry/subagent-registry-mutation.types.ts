import type { SessionEntryCurrentCheck } from "../../../config/sessions/session-entry-current.types.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentRunMutation<T> = {
  value: T;
  postimages?: ReadonlyMap<string, SubagentRunRecord | null>;
  versions?: ReadonlyMap<string, string | null>;
  rekeys?: ReadonlyMap<string, string>;
  terminalEvents?: readonly {
    input: NonNullable<SubagentRegistryWrite["terminalEvents"]>[number];
    sessionEntryCurrent?: SessionEntryCurrentCheck;
  }[];
};
