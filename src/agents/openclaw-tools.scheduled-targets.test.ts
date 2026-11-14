import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("./openclaw-plugin-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-plugin-tools.js")>()),
  resolveOpenClawPluginToolsForOptions: () => [],
}));
const spawnToolOptions = vi.hoisted(
  () => [] as Array<{ senderIsOwner?: boolean; assertSenderOwnerCurrent?: () => void }>,
);
vi.mock("./tools/sessions-spawn-tool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools/sessions-spawn-tool.js")>();
  return {
    ...actual,
    createSessionsSpawnTool: (options: Parameters<typeof actual.createSessionsSpawnTool>[0]) => {
      spawnToolOptions.push({
        senderIsOwner: options?.senderIsOwner,
        assertSenderOwnerCurrent: options?.assertSenderOwnerCurrent,
      });
      return actual.createSessionsSpawnTool(options);
    },
  };
});
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

// A scheduled owner run carries no sender bit, so without the occurrence's bit its
// children recorded a non-owner spawn and lost the run's owner-private memory.
it.each([
  [true, undefined, true],
  [false, undefined, false],
  [undefined, false, false],
] as const)(
  "records occurrence owner bit %s (run sender bit %s) on scheduled spawns",
  (spawnSenderIsOwner, senderIsOwner, expected) => {
    spawnToolOptions.length = 0;
    const assertOwnerCurrent = () => {};
    createOpenClawTools({
      agentSessionKey: "agent:main:cron:job-1",
      runSessionKey: "agent:main:cron:job-1:run:run-session",
      gatewayCallerScheduled: true,
      ...(senderIsOwner === undefined ? {} : { senderIsOwner }),
      scheduledToolTargets: {
        boardSessionKey: PARENT_KEY,
        assertCurrent: () => {},
        assertOwnerCurrent,
        ...(spawnSenderIsOwner === undefined ? {} : { spawnSenderIsOwner }),
      },
    });
    expect(spawnToolOptions.length).toBeGreaterThan(0);
    expect(new Set(spawnToolOptions.map((options) => options.senderIsOwner))).toEqual(
      new Set([expected]),
    );
    // An owner bit taken from the occurrence is rechecked against its requester per spawn.
    expect(new Set(spawnToolOptions.map((options) => options.assertSenderOwnerCurrent))).toEqual(
      new Set([spawnSenderIsOwner ? assertOwnerCurrent : undefined]),
    );
  },
);
