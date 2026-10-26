import { expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "./agent-tools.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

it.each([
  ["sessions", "sessions_create"],
  ["sessions_create", "sessions"],
])("denying %s preserves %s", (denied, retained) => {
  const names = createOpenClawCodingTools({
    config: { tools: { allow: ["sessions", "sessions_create"], deny: [denied] } },
    sessionKey: "agent:main:main",
    senderIsOwner: false,
    workspaceDir: process.cwd(),
  }).map((tool) => tool.name);
  expect(names).not.toContain(denied);
  expect(names).toContain(retained);
});
