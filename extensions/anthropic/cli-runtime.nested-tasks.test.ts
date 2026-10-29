import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import { afterEach, expect, it } from "vitest";
import { executeClaudeCli } from "./cli.runtime.js";

const roots: string[] = [];
const handles = new Set<CliBackendLiveSessionHandle>();
afterEach(async () => {
  for (const handle of handles) {
    handle.close("restart");
    await handle.waitForExit();
  }
  handles.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = String.raw`
import { createInterface } from "node:readline";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const system = (subtype, fields) => send({ type: "system", subtype, ...fields });
const result = (answer, fields = {}) => send({ type: "result", subtype: "success",
  result: answer, session_id: "nested-fixture", num_turns: 1, stop_reason: "end_turn", ...fields });
const notification = (task_id) => system("task_notification", { task_id, status: "completed" });
const replay = (task_id) => send({ type: "user", isReplay: true, parent_tool_use_id: null,
  message: { content: "<task-notification><task-id>" + task_id + "</task-id></task-notification>" } });
const mode = process.env.NESTED_MODE;
const ancestry = process.env.ANCESTRY_SCENARIO ? JSON.parse(process.env.ANCESTRY_SCENARIO) : undefined;
const child = { task_id: "child", task_type: process.env.CHILD_TYPE, parent_task_id: "parent" };
const parent = { task_id: "parent", task_type: "local_agent" };
let input = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    system("init", { capabilities: ["msg_lifecycle_v1"] });
    if (mode === "before-input") system("background_tasks_changed", { tasks: [parent, child] });
    if (ancestry?.beforeInput) system("background_tasks_changed", { tasks: ancestry.beforeInput });
  } else if (message.type === "user") {
    input++;
    send({ type: "command_lifecycle", state: "started", command_uuid: message.uuid });
    if (input > 1) {
      if (mode === "old-input") {
        system("background_tasks_changed", { tasks: [parent, child] });
        notification("parent"); notification("child");
      }
      result("warm reply"); continue;
    }
    if (ancestry) {
      for (const id of ancestry.notified ?? []) system("task_notification", { task_id: id, status: "stopped" });
      system("task_started", { ...ancestry.tasks.find(task => task.task_id === ancestry.chain[0]), is_backgrounded: true });
      system("background_tasks_changed", { tasks: ancestry.tasks });
      result("waiting");
      if (ancestry.stopAfterWaiting) continue;
      for (const id of ancestry.chain) {
        notification(id);
        result(id + " reply", { origin: { kind: "task-notification" } });
      }
      continue;
    }
    if (mode === "before-input") {
      system("background_tasks_changed", { tasks: [parent, child] }); result("unrelated reply"); continue;
    }
    system("task_started", { ...parent, is_backgrounded: mode === "foreground" ? false : true });
    if (mode !== "foreground" && mode !== "old-input") {
      system("background_tasks_changed", { tasks: [parent] }); result("waiting");
    }
    system("background_tasks_changed", { tasks: mode === "foreground" ? [child] : mode === "reverse-list" ? [child, parent] : [parent, child] });
    system("task_started", { ...child, is_backgrounded: true,
      ...(mode === "owned-list-first" ? { owned_by_subagent: true } : {}) });
    if (mode === "old-input") {
      notification("child"); notification("parent"); replay("parent"); result("first reply"); continue;
    }
    if (mode.startsWith("parent-first")) {
      notification("parent");
      if (mode === "parent-first") replay("parent");
      result("parent reply", { origin: { kind: "task-notification" } });
      notification("child");
      if (mode === "parent-first") replay("child");
      result("forwarded child reply", { origin: { kind: "task-notification" } });
    } else if (mode === "foreground") {
      result("foreground reply");
    } else {
      notification("child");
      if (mode === "duplicate") notification("child");
      system("background_tasks_changed", { tasks: [parent] });
      notification("parent"); replay("parent"); result("parent reply");
    }
  }
}
`;

type AncestryTask = {
  task_id: string;
  task_type: "local_agent" | "local_workflow";
  parent_task_id?: string;
  owned_by_subagent?: boolean;
};
type AncestryScenario = {
  chain: string[];
  tasks: AncestryTask[];
  beforeInput?: AncestryTask[];
  notified?: string[];
  stopAfterWaiting?: boolean;
};

async function context(mode: string, childType = "local_agent", ancestry?: AncestryScenario) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-nested-"));
  roots.push(root);
  const script = path.join(root, "fixture.mjs");
  await writeFile(script, fixture);
  let current: CliBackendLiveSessionHandle | undefined;
  const liveSession: CliBackendLiveSessionCapability = {
    fingerprint: "nested-fixture",
    current: () => current,
    register: (handle) => {
      current = handle;
      handles.add(handle);
    },
    remove: (handle) => {
      if (current === handle) {
        current = undefined;
      }
    },
    activate: () => {},
    restart: async () => {
      current?.close("restart");
      await current?.waitForExit();
    },
  };
  return {
    command: process.execPath,
    args: [script],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLAUDE_CONFIG_DIR: root,
      NESTED_MODE: mode,
      CHILD_TYPE: childType,
      ...(ancestry ? { ANCESTRY_SCENARIO: JSON.stringify(ancestry) } : {}),
    },
    prompt: "first",
    systemPrompt: "fixture",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    liveSession,
    timeoutMs: 1500,
    abortSignal: AbortSignal.timeout(2000),
    requestToolPermission: async () => ({ behavior: "deny", message: "unused" }),
    requestUserInput: async () => ({ status: "cancelled", message: "unused" }),
  } satisfies CliBackendExecuteContext;
}
async function collect(ctx: CliBackendExecuteContext) {
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli(ctx)) {
    records.push(record);
  }
  return records.filter((record) => record.type === "result");
}
it.each(["local_agent", "local_workflow"])(
  "settles nested %s while its background parent consumes its notification",
  async (childType) => {
    const ctx = await context("child-first", childType);
    const results = await collect(ctx);
    expect(results.map((record) => record.result)).toEqual(["waiting", "parent reply"]);
    expect(results[0]).toHaveProperty("openclaw_interim_result", true);
    expect(results[1]).not.toHaveProperty("openclaw_interim_result");
    expect(ctx.liveSession.current()?.isIdle()).toBe(true);
    expect((await collect({ ...ctx, useResume: true, prompt: "next" }))[0]?.result).toBe(
      "warm reply",
    );
  },
);

it.each(["local_agent", "local_workflow"])(
  "waits for a forwarded nested %s result after its background parent ends",
  async (childType) => {
    const ctx = await context("parent-first", childType);
    const results = await collect(ctx);
    expect(results.map((record) => record.result)).toEqual([
      "waiting",
      "parent reply",
      "forwarded child reply",
    ]);
    expect(results[1]).toHaveProperty("openclaw_interim_result", true);
    expect(results[2]).not.toHaveProperty("openclaw_interim_result");
    expect(ctx.liveSession.current()?.isIdle()).toBe(true);
  },
);
it.each([
  "foreground",
  "before-input",
  "old-input",
  "duplicate",
  "reverse-list",
  "owned-list-first",
])("preserves ownership across %s ordering", async (mode) => {
  const ctx = await context(mode);
  const results = await collect(ctx);
  const expected =
    mode === "foreground"
      ? "foreground reply"
      : mode === "before-input"
        ? "unrelated reply"
        : mode === "old-input"
          ? "first reply"
          : "parent reply";
  expect(results.at(-1)?.result).toBe(expected);
  expect(results.at(-1)).not.toHaveProperty("openclaw_interim_result");
  expect(ctx.liveSession.current()?.isIdle()).toBe(true);
  expect((await collect({ ...ctx, useResume: true, prompt: "next" }))[0]?.result).toBe(
    "warm reply",
  );
});

it.each(["local_agent", "local_workflow"])(
  "consumes queued forwarded %s results without inline replay receipts",
  async (childType) => {
    const ctx = await context("parent-first-native", childType);
    const results = await collect(ctx);
    expect(results.map((record) => record.result)).toEqual([
      "waiting",
      "parent reply",
      "forwarded child reply",
    ]);
    expect(results[1]).toHaveProperty("openclaw_interim_result", true);
    expect(results[2]).not.toHaveProperty("openclaw_interim_result");
    expect(ctx.liveSession.current()?.isIdle()).toBe(true);
  },
);

function ancestryScenario(order: number[], taskType: AncestryTask["task_type"]): AncestryScenario {
  const chain = order.map((_, index) => "level-" + index);
  return {
    chain,
    tasks: order.map((index) => ({
      task_id: chain[index]!,
      task_type: taskType,
      ...(index > 0 ? { parent_task_id: chain[index - 1]! } : {}),
    })),
  };
}

const ancestryOrders = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
  [4, 3, 2, 1, 0],
  [2, 4, 0, 3, 1],
];
it.each(
  (["local_agent", "local_workflow"] as const).flatMap((taskType) =>
    ancestryOrders.map((order) => ({ taskType, order })),
  ),
)("preserves deep ancestry answers for $taskType order $order", async ({ taskType, order }) => {
  const scenario = ancestryScenario(order, taskType);
  const ctx = await context("ancestry", taskType, scenario);
  const results = await collect(ctx);
  expect(results.map((record) => record.result)).toEqual([
    "waiting",
    ...scenario.chain.map((id) => id + " reply"),
  ]);
  expect(results.slice(0, -1).every((record) => record.openclaw_interim_result === true)).toBe(
    true,
  );
  expect(results.at(-1)).not.toHaveProperty("openclaw_interim_result");
  expect(ctx.liveSession.current()?.isIdle()).toBe(true);
  expect((await collect({ ...ctx, useResume: true, prompt: "next" }))[0]?.result).toBe(
    "warm reply",
  );
});

it.each(["owned", "old-input", "notified", "cycle", "orphan"] as const)(
  "does not acquire excluded descendant holds through %s ancestry",
  async (exclusion) => {
    const scenario = ancestryScenario([2, 1, 0], "local_agent");
    const excluded: AncestryTask = {
      task_id: "excluded",
      task_type: "local_workflow",
      parent_task_id: scenario.chain[0],
    };
    const descendant: AncestryTask = {
      task_id: "excluded-child",
      task_type: "local_agent",
      parent_task_id: "excluded",
    };
    if (exclusion === "owned") {
      excluded.owned_by_subagent = true;
    } else if (exclusion === "old-input") {
      scenario.beforeInput = [excluded];
    } else if (exclusion === "notified") {
      scenario.notified = [excluded.task_id];
    } else if (exclusion === "cycle") {
      excluded.parent_task_id = descendant.task_id;
    } else {
      excluded.parent_task_id = "unknown-parent";
    }
    scenario.tasks.unshift(descendant, excluded);
    const ctx = await context("ancestry", "local_agent", scenario);
    const results = await collect(ctx);
    expect(results.map((record) => record.result)).toEqual([
      "waiting",
      ...scenario.chain.map((id) => id + " reply"),
    ]);
    expect(results.at(-1)).not.toHaveProperty("openclaw_interim_result");
    expect(ctx.liveSession.current()?.isIdle()).toBe(true);
  },
);

it("retires deep ancestry holds when the consumer cancels the stream", async () => {
  const scenario = ancestryScenario([4, 3, 2, 1, 0], "local_agent");
  scenario.stopAfterWaiting = true;
  const ctx = await context("ancestry", "local_agent", scenario);
  let sawWaiting = false;
  for await (const record of executeClaudeCli(ctx)) {
    if (record.type === "result") {
      expect(record).toMatchObject({ result: "waiting", openclaw_interim_result: true });
      sawWaiting = true;
      break;
    }
  }
  expect(sawWaiting).toBe(true);
  expect(ctx.liveSession.current()).toBeUndefined();
});
