import { expect, it } from "vitest";
import { classifyAcpToolApproval } from "./approval-classifier.js";

function check(
  toolCall: Parameters<typeof classifyAcpToolApproval>[0]["toolCall"],
  toolName: string,
  approvalClass: string,
  autoApprove = false,
) {
  expect(classifyAcpToolApproval({ cwd: "/workspace", toolCall })).toEqual({
    toolName,
    approvalClass,
    autoApprove,
  });
}

it.each([
  ["list_windows", "other"],
  ["left_click", "mutating"],
])("keeps computer %s behind approval", (action, approvalClass) => {
  check({ title: "computer", rawInput: { name: "computer", action } }, "computer", approvalClass);
});
it.each([
  ["FILE://remote.example/outside/marker.txt", "other", false],
  ["file:/workspace/src/index.ts", "readonly_scoped", true],
] as const)("classifies file URL %s", (path, approvalClass, autoApprove) => {
  check(
    { title: "read: ignored-by-raw-input", rawInput: { path } },
    "read",
    approvalClass,
    autoApprove,
  );
});
it("does not auto-approve reads from locations-only metadata", () => {
  check({ title: "read", locations: [{ path: "src/index.ts" }] }, "read", "other");
});
it("auto-approves readonly search tools", () => {
  check(
    { title: "memory_search: vectors", rawInput: { name: "memory_search", query: "vectors" } },
    "memory_search",
    "readonly_search",
    true,
  );
});
it("does not auto-approve alias search when any location escapes cwd", () => {
  check(
    {
      title: "search: TODO",
      rawInput: { name: "search", query: "TODO" },
      locations: [{ path: "src/index.ts" }, { path: "/etc/passwd" }],
    },
    "search",
    "other",
  );
});
