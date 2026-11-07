import { describe, expect, it } from "vitest";
import { AgentHarnessPreflightError } from "../harness/errors.js";
import { renderAgentHarnessPreflightUserMessage } from "./user-facing-text.js";

describe("desktop-only preflight detail", () => {
  it("does not promote desktop detail into channel or mobile error copy", () => {
    const error = new AgentHarnessPreflightError("private internal diagnostic", {
      desktopMessage: "Review this chat's permissions before retrying.",
    });
    expect(renderAgentHarnessPreflightUserMessage(error)).toBeUndefined();
    expect(renderAgentHarnessPreflightUserMessage(error, { audience: "desktop" })).toBe(
      "Review this chat's permissions before retrying.",
    );
  });

  it("keeps existing public guidance unchanged outside desktop viewers", () => {
    const error = new AgentHarnessPreflightError("private internal diagnostic", {
      userMessage: "Existing public guidance.",
      desktopMessage: "Desktop guidance.",
    });
    expect(renderAgentHarnessPreflightUserMessage(error)).toBe("Existing public guidance.");
    expect(renderAgentHarnessPreflightUserMessage(error, { audience: "desktop" })).toBe(
      "Desktop guidance.",
    );
  });
});
