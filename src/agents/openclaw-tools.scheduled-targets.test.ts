import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("./openclaw-plugin-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-plugin-tools.js")>()),
  resolveOpenClawPluginToolsForOptions: () => [],
}));
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

const PARENT_KEY = "agent:main:dashboard:parent";

function scheduledChildTools(scheduledToolTargets?: {
  boardSessionKey: string;
  assertCurrent: () => void;
}) {
  return createOpenClawTools({
    agentSessionKey: "agent:main:cron:job-1",
    runSessionKey: "agent:main:cron:job-1:run:run-session",
    gatewayCallerScheduled: true,
    runtimeToolAllowlist: ["show_widget", "dashboard"],
    ...(scheduledToolTargets ? { scheduledToolTargets } : {}),
  });
}

// Board writes for these targets are proven against the real board store in
// src/cron/execution-context-board-effects.test.ts.
it("offers pinned widget authoring to a scheduled child of a conversation", () => {
  // Without a context the run key blocks pinned authoring (the observed empty-board failure).
  expect(scheduledChildTools().find((tool) => tool.name === "show_widget")).toBeUndefined();
  const widget = scheduledChildTools({
    boardSessionKey: PARENT_KEY,
    assertCurrent: () => {},
  }).find((tool) => tool.name === "show_widget");
  expect(widget?.parameters).toMatchObject({ properties: { pin: { const: true } } });
});
