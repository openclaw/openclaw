export * from "./subagent-announce-output.js";
export { buildChildCompletionFindings } from "./subagent-announce-result.js";

type OutputRuntime = typeof import("./subagent-announce.runtime.js");
type OutputDeps = Pick<
  OutputRuntime,
  | "getRuntimeConfig"
  | "readSubagentSessionEntry"
  | "readSessionMessagesAsync"
  | "resolveAgentIdFromSessionKey"
  | "resolveSessionStorePathCore"
> & {
  callGateway: OutputRuntime["callSubagentLifecycleGateway"];
  findTranscriptEvent: typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;
  findSessionTranscriptArchiveEventReadOnly: typeof import("../../../config/sessions/session-history.js").findSessionTranscriptArchiveEventReadOnly;
};

type Testing = {
  setDepsForTest(overrides?: Partial<OutputDeps>): void;
};

function getTesting(): Testing {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentAnnounceOutputTestApi")
  ] as Testing;
}

export const testing: Testing = {
  setDepsForTest: (overrides) => getTesting().setDepsForTest(overrides),
};
