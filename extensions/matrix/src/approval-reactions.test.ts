import { describe, expect, it } from "vitest";
import {
  buildMatrixApprovalReactionHint,
  listMatrixApprovalReactionBindings,
  resolveMatrixApprovalReactionTarget,
} from "./approval-reactions.js";

describe("matrix approval reactions", () => {
  it("lists reactions in stable decision order", () => {
    expect(listMatrixApprovalReactionBindings(["allow-once", "deny", "allow-always"])).toEqual([
      { decision: "allow-once", emoji: "✅", label: "Allow once" },
      { decision: "allow-always", emoji: "♾️", label: "Allow always" },
      { decision: "deny", emoji: "❌", label: "Deny" },
    ]);
  });

  it("builds a compact reaction hint", () => {
    expect(buildMatrixApprovalReactionHint(["allow-once", "deny"])).toBe(
      "React here: ✅ Allow once, ❌ Deny",
    );
  });

  it("resolves a reaction back to the approval decision exposed in the prompt text", () => {
    const text = [
      "Approval required.",
      "",
      "Run:",
      "```txt",
      "/approve req-123 allow-once",
      "```",
      "",
      "Other options:",
      "```txt",
      "/approve req-123 allow-always",
      "/approve req-123 deny",
      "```",
    ].join("\n");

    expect(resolveMatrixApprovalReactionTarget(text, "✅")).toEqual({
      approvalId: "req-123",
      decision: "allow-once",
    });
    expect(resolveMatrixApprovalReactionTarget(text, "♾️")).toEqual({
      approvalId: "req-123",
      decision: "allow-always",
    });
    expect(resolveMatrixApprovalReactionTarget(text, "❌")).toEqual({
      approvalId: "req-123",
      decision: "deny",
    });
  });

  it("ignores reactions that are not available in the prompt text", () => {
    const text = [
      "Approval required.",
      "",
      "Run:",
      "```txt",
      "/approve req-123 allow-once",
      "```",
      "",
      "Other options:",
      "```txt",
      "/approve req-123 deny",
      "```",
    ].join("\n");

    expect(resolveMatrixApprovalReactionTarget(text, "♾️")).toBeNull();
  });

  it("reuses the shared command parser for mention and legacy alias forms", () => {
    const text = [
      "Approval required.",
      "",
      "Run:",
      "```txt",
      "/approve@claw req-123 allow-once",
      "```",
      "",
      "Other options:",
      "```txt",
      "/approve req-123 always",
      "/approve req-123 deny",
      "```",
    ].join("\n");

    expect(resolveMatrixApprovalReactionTarget(text, "♾️")).toEqual({
      approvalId: "req-123",
      decision: "allow-always",
    });
  });
});
