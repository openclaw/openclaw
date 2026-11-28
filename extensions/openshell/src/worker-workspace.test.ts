import { expect, it } from "vitest";
import { prepareOpenShellAgentWorkspace } from "./worker-workspace.js";

const workspace = { agentId: "main" } as Parameters<typeof prepareOpenShellAgentWorkspace>[1];

// The loader's activation policy decides; a hand-read check missed normalized ids (#205672).
it.each([
  { deny: [" File-Transfer "] },
  { allow: ["browser"] },
  { entries: { "file-transfer": { enabled: false } } },
])("keeps an operator's File Transfer restriction: %j", (plugins) => {
  const config = { plugins } as Parameters<typeof prepareOpenShellAgentWorkspace>[0];
  expect(() => prepareOpenShellAgentWorkspace(config, workspace, "node", config)).toThrow(
    "Agent workspace binding requires File Transfer",
  );
});
