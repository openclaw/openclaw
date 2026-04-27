import { runEmbeddedAttempt } from "../pi-embedded-runner/run/attempt.js";
export function createPiAgentHarness() {
    return {
        id: "pi",
        label: "PI embedded agent",
        supports: () => ({ supported: true, priority: 0 }),
        runAttempt: runEmbeddedAttempt,
    };
}
