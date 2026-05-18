// Agent OS WS13 — L1 pure-plugin simulated handler/unit proof barrel.
//
// Pure, inert exports. Importing this module activates nothing: no Gateway,
// no live OpenClaw runtime, no Slack delivery, no hook registration. The
// scenario harness is executable proof but is NOT run on import.

export * from "./types.js";
export * from "./privacy.js";
export * from "./correlation.js";
export * from "./health.js";
export {
  Ws13Clock,
  Ws13ObligationStore,
  Ws13StoreUnavailableError,
} from "./obligation-store.js";
export { Ws13HookEngine } from "./hook-handlers.js";
export { renderEvidenceMarkdown } from "./proof-recorder.js";
export {
  runWs13Scenarios,
  scenarioA,
  scenarioB,
  scenarioC,
  scenarioD,
  scenarioE,
  scenarioF,
  scenarioG,
} from "./scenarios.js";
