import { describe, expect, it } from "vitest";
import { classifyAcpToolApproval } from "./approval-classifier.js";

function classify(toolCall: Parameters<typeof classifyAcpToolApproval>[0]["toolCall"]) {
  return classifyAcpToolApproval({ cwd: "/workspace", toolCall });
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

  it.each([
    ["FILE://remote.example/outside/marker.txt", "other", false],
    ["file:/workspace/src/index.ts", "readonly_scoped", true],
  ])("classifies file URL %s", (fileUrl, approvalClass, autoApprove) => {
    expect(
      classify({
        title: "read: ignored-by-raw-input",
        rawInput: { path: fileUrl },
      }),
    ).toEqual({
      toolName: "read",
      approvalClass,
      autoApprove,
    });
  });

  it("does not auto-approve reads from locations-only metadata", () => {
    expect(classify({ title: "read", locations: [{ path: "src/index.ts" }] })).toEqual({
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
});
