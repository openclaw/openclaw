import { expect, it } from "vitest";
// The public entry point must expose the registered validator, not only its schema.
import { validateChatSteerParams } from "./index.js";

it("requires the original queued identity and refuses replacement payloads", () => {
  const source = {
    sessionKey: "global",
    agentId: "work",
    sessionId: "original-session",
    runId: "original-run",
  };
  expect(validateChatSteerParams(source)).toBe(true);
  for (const replacement of [
    { ...source, sessionId: undefined },
    { ...source, runId: undefined },
    { ...source, sessionId: "" },
    { ...source, runId: "" },
    { ...source, message: "replacement text" },
    { ...source, attachments: [] },
    { ...source, toolBindings: {} },
    { ...source, queueMode: "interrupt" },
  ]) {
    expect(validateChatSteerParams(replacement)).toBe(false);
  }
});
