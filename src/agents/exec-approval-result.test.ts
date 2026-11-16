// Exec approval result tests cover parsing gateway/node approval payloads and
// mapping denied metadata to safe user-facing copy.
import { describe, expect, it, vi } from "vitest";
import {
  formatExecDeniedUserMessage,
  isExecDeniedResultText,
  parseExecApprovalResultText,
} from "./exec-approval-result.js";

describe("parseExecApprovalResultText", () => {
  it.each(["", "Exec finished (gateway id=req-1, code 0)\n"])(
    "classifies %j without case-folding command output",
    (prefix) => {
      const body = "Mixed-case COMMAND output\n".repeat(1_000);
      const input = `${prefix}${body}`;
      const lowercase = vi.spyOn(String.prototype, "toLowerCase");
      let normalizedLengths: number[];
      try {
        const parsed = parseExecApprovalResultText(input);
        normalizedLengths = lowercase.mock.contexts.map((value) => String(value).length);
        expect(parsed.raw).toBe(input.trim());
        expect(parsed.kind).toBe(prefix ? "finished" : "other");
      } finally {
        lowercase.mockRestore();
      }
      expect(normalizedLengths.every((length) => length <= "Exec outcome unknown (".length)).toBe(
        true,
      );
    },
  );

  it.each([
    [
      "denied",
      "gateway id=req-1, approval-timeout (allowlist-miss)",
      ": ",
      "source ~/.zprofile && kubectl get pods",
    ],
    // The gateway emits colon-separated reasons, but nested metadata remains readable.
    [
      "denied",
      "gateway id=req-1, approval-timeout: allowlist-miss",
      ": ",
      "source ~/.zprofile && kubectl get pods",
    ],
    ["finished", "gateway id=req-1, note (nested), code 0", "\n", "all good"],
  ])("parses %s metadata %s", (kind, metadata, separator, body) => {
    const input = `Exec ${kind} (${metadata})${separator}${body}`;
    expect(parseExecApprovalResultText(input)).toEqual({
      kind,
      raw: input,
      metadata,
      body,
    });
  });

  it("parses completed results", () => {
    expect(parseExecApprovalResultText("Exec completed: done")).toEqual({
      kind: "completed",
      raw: "Exec completed: done",
      body: "done",
    });
  });

  it("returns other for unmatched payloads", () => {
    expect(parseExecApprovalResultText("some random text")).toEqual({
      kind: "other",
      raw: "some random text",
    });
  });

  it.each(["Exec denied (request-id=abc, denied): cmd", "Exec finished (status: ok)\nbody"])(
    "returns other when metadata is not gateway/node sourced (CWE-841 spoof guard): %s",
    (input) => {
      // Only gateway/node-sourced payloads get parsed as approval results; prose
      // that looks similar must not spoof command approval state.
      expect(parseExecApprovalResultText(input)).toEqual({
        kind: "other",
        raw: input,
      });
    },
  );
});

describe("isExecDeniedResultText", () => {
  it("matches denied payloads case-insensitively", () => {
    expect(
      isExecDeniedResultText("exec denied (gateway id=req-1, approval-timeout): uname -a"),
    ).toBe(true);
  });

  it("does not match non-denied payloads", () => {
    expect(isExecDeniedResultText("Exec finished (gateway id=req-1, code 0)")).toBe(false);
  });
});

describe("formatExecDeniedUserMessage", () => {
  it.each([
    [
      "Exec denied (gateway id=req-1, approval-timeout: allowlist-miss): uname -a",
      "Command did not run: approval timed out.",
    ],
    [
      "Exec denied (gateway id=req-1, user-denied): uname -a",
      "Command did not run: an operator declined this execution approval.",
    ],
    [
      "Exec denied (gateway id=req-1, allowlist-miss): uname -a",
      "Command did not run: approval is required.",
    ],
    [
      "Exec denied (gateway id=req-1, approval-request-failed): uname -a",
      "Command did not run: approval request failed.",
    ],
    ["Exec denied (gateway id=req-1, spawn-failed): uname -a", "Command did not run."],
  ] as const)("maps denied metadata to safe copy", (input, expected) => {
    expect(formatExecDeniedUserMessage(input)).toBe(expected);
  });

  it("returns null for non-denied payloads", () => {
    expect(formatExecDeniedUserMessage("Exec finished (gateway id=req-1, code 0)")).toBeNull();
  });
});
