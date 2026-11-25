import { expect, it } from "vitest";
import { AgentHarnessPreflightError } from "../harness/errors.js";
import { renderAgentHarnessPreflightUserMessage } from "./user-facing-text.js";

it.each([
  [undefined, "Desktop-only guidance."],
  ["Public guidance.", "Desktop guidance."],
])("keeps preflight audiences separate for public guidance %s", (userMessage, desktopMessage) => {
  const error = new AgentHarnessPreflightError("private diagnostic", {
    userMessage,
    desktopMessage,
  });
  expect(renderAgentHarnessPreflightUserMessage(error)).toBe(userMessage);
  expect(renderAgentHarnessPreflightUserMessage(error, { audience: "desktop" })).toBe(
    desktopMessage,
  );
});
