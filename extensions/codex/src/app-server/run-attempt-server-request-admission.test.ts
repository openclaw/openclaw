import { describe, expect, it } from "vitest";
import { createCodexServerRequestAdmissionController } from "./run-attempt-server-request-admission.js";

describe("Codex server request admission", () => {
  it("closes every preserved dynamic-tool admission after final-source grace", () => {
    const controller = createCodexServerRequestAdmissionController();
    const owner = controller.admit({ preserveOnSeal: true });
    const sibling = controller.admit({ preserveOnSeal: true });
    const nonTool = controller.admit();

    controller.seal(owner);

    expect(owner.signal.aborted).toBe(false);
    expect(sibling.signal.aborted).toBe(false);
    expect(nonTool.signal).toMatchObject({
      aborted: true,
      reason: "codex_final_source_reply_committed",
    });
    expect(controller.admit().signal).toMatchObject({
      aborted: true,
      reason: "codex_final_source_reply_committed",
    });

    controller.close();

    expect(owner.signal).toMatchObject({ aborted: true, reason: "codex_turn_complete" });
    expect(sibling.signal).toMatchObject({ aborted: true, reason: "codex_turn_complete" });
  });
});
