/** Tests ACP tool approval classification and spoofing backstops. */
import { describe, expect, it } from "vitest";
import { classifyAcpToolApproval } from "./approval-classifier.js";

function classify(params: {
  title: string;
  locations?: Array<{ path: string; line?: number }>;
  rawInput?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  cwd?: string;
}) {
  return classifyAcpToolApproval({
    cwd: params.cwd ?? "/workspace",
    toolCall: {
      title: params.title,
      locations: params.locations,
      rawInput: params.rawInput,
      _meta: params.meta,
    },
  });
}

describe("classifyAcpToolApproval", () => {
  it.each([
    ["list_windows", "other"],
    ["left_click", "mutating"],
  ])("keeps computer %s behind approval", (action, approvalClass) => {
    expect(classify({ title: "computer", rawInput: { name: "computer", action } })).toEqual({
      toolName: "computer",
      approvalClass,
      autoApprove: false,
    });
  });

  it.each(["file://localhost/outside/marker.txt", "FILE://remote.example/outside/marker.txt"])(
    "does not auto-approve out-of-cwd file URL %s",
    (fileUrl) => {
      expect(
        classify({
          title: "read: ignored-by-raw-input",
          rawInput: { path: fileUrl },
        }),
      ).toEqual({
        toolName: "read",
        approvalClass: "other",
        autoApprove: false,
      });
    },
  );

  it.each(["FILE:///workspace/src/index.ts", "file:/workspace/src/index.ts"])(
    "auto-approves in-cwd file URL %s",
    (fileUrl) => {
      expect(
        classify({
          title: "read: ignored-by-raw-input",
          rawInput: { path: fileUrl },
        }),
      ).toEqual({
        toolName: "read",
        approvalClass: "readonly_scoped",
        autoApprove: true,
      });
    },
  );

  it("does not auto-approve reads from locations-only metadata", () => {
    expect(
      classify({
        title: "read",
        locations: [{ path: "src/index.ts" }],
      }),
    ).toEqual({
      toolName: "read",
      approvalClass: "other",
      autoApprove: false,
    });
  });

  it("auto-approves readonly search tools", () => {
    expect(
      classify({
        title: "memory_search: vectors",
        rawInput: { name: "memory_search", query: "vectors" },
      }),
    ).toEqual({
      toolName: "memory_search",
      approvalClass: "readonly_search",
      autoApprove: true,
    });
  });

  it("does not auto-approve alias search when any location escapes cwd", () => {
    expect(
      classify({
        title: "search: TODO",
        rawInput: { name: "search", query: "TODO" },
        locations: [{ path: "src/index.ts" }, { path: "/etc/passwd" }],
      }),
    ).toEqual({
      toolName: "search",
      approvalClass: "other",
      autoApprove: false,
    });
  });

  it("classifies mutating messaging tools as mutating", () => {
    expect(
      classify({
        title: "message: send",
        rawInput: { name: "message", action: "send", message: "hi" },
      }),
    ).toEqual({
      toolName: "message",
      approvalClass: "mutating",
      autoApprove: false,
    });
  });
});
