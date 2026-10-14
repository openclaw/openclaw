import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "./transcript-visibility.js";

const refresh = { kind: "internal_system", sourceTool: "progress_card_refresh" } as const;
describe("progress refresh transcript visibility", () => {
  it("hides status-only user, assistant and tool messages", () => {
    for (const role of ["user", "assistant", "toolResult"] as const) {
      const message = {
        role,
        content: [{ type: "text", text: "Refresh-only content" }],
      } as AgentMessage;
      expect(
        projectAgentHarnessTranscriptMessageForDisplay({
          hidden: false,
          inputProvenance: refresh,
          message,
        }),
      ).toMatchObject({ display: false });
      expect(Reflect.get(message, "display")).toBeUndefined();
    }
  });
  it("hides steered refresh input without hiding the active human turn's answer", () => {
    const input = {
      role: "user",
      content: "Update the card",
      timestamp: 1,
      provenance: refresh,
    } as AgentMessage;
    const answer = {
      role: "assistant",
      content: [{ type: "text", text: "The actual work is complete." }],
    } as AgentMessage;
    expect(
      projectAgentHarnessTranscriptMessageForDisplay({ hidden: false, message: input }),
    ).toMatchObject({ display: false });
    expect(projectAgentHarnessTranscriptMessageForDisplay({ hidden: false, message: answer })).toBe(
      answer,
    );
  });
});
