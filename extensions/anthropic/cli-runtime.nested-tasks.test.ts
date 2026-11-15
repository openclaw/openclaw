import { afterEach, expect, it } from "vitest";
import {
  collectClaudeCli as collect,
  createCliTestHarness,
  withClaudeCliTestDeadline,
} from "./cli-runtime.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";

const fixture = String.raw`
import { createInterface } from "node:readline";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const system = (subtype, fields) => send({ type: "system", subtype, ...fields });
const result = (answer, fields = {}) => send({ type: "result", subtype: "success",
  result: answer, session_id: "nested-fixture", num_turns: 1, stop_reason: "end_turn", ...fields });
const scenario = JSON.parse(process.env.ANCESTRY_SCENARIO);
let input = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    system("init", { capabilities: ["msg_lifecycle_v1"] });
    if (scenario.beforeInput) system("background_tasks_changed", { tasks: scenario.beforeInput });
  } else if (message.type === "user") {
    input++;
    send({ type: "command_lifecycle", state: "started", command_uuid: message.uuid });
    if (input > 1) {
      result("warm reply");
      continue;
    }
    system("task_started", { ...scenario.tasks.find((task) => task.task_id === scenario.chain[0]), is_backgrounded: true });
    system("background_tasks_changed", { tasks: scenario.tasks });
    result("waiting");
    if (scenario.stopAfterWaiting) continue;
    for (const id of scenario.chain) {
      system("task_notification", { task_id: id, status: "completed" });
      result(id + " reply", { origin: { kind: "task-notification" } });
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
  stopAfterWaiting?: boolean;
};

const harness = createCliTestHarness("claude-nested-");
afterEach(() => harness.cleanup());

const context = (scenario: AncestryScenario) =>
  harness.context(
    fixture,
    { liveSession: harness.liveSession() },
    { ANCESTRY_SCENARIO: JSON.stringify(scenario) },
  );

const results = async (records: Promise<Record<string, unknown>[]>) =>
  (await records).filter((record) => record.type === "result");

function ancestryScenario(order: number[], taskType: AncestryTask["task_type"]): AncestryScenario {
  const chain = order.map((_, index) => `level-${index}`);
  return {
    chain,
    tasks: order.map((index) => ({
      task_id: chain[index] ?? "",
      task_type: taskType,
      ...(index > 0 ? { parent_task_id: chain[index - 1] } : {}),
    })),
  };
}

it.each([
  { order: [1, 0], taskType: "local_agent" },
  { order: [2, 1, 0], taskType: "local_agent" },
  { order: [2, 1, 0], taskType: "local_workflow" },
  { order: [2, 4, 0, 3, 1], taskType: "local_agent" },
] as const)(
  "preserves deep ancestry answers for $taskType order $order",
  async ({ order, taskType }) => {
    const scenario = ancestryScenario([...order], taskType);
    const ctx = await context(scenario);
    const records = await results(collect(ctx));
    expect(records.map((record) => record.result)).toEqual([
      "waiting",
      ...scenario.chain.map((id) => `${id} reply`),
    ]);
    expect(records.slice(0, -1).every((record) => record.openclaw_interim_result === true)).toBe(
      true,
    );
    expect(records.at(-1)).not.toHaveProperty("openclaw_interim_result");
    expect(ctx.liveSession?.current()?.isIdle()).toBe(true);
    expect((await results(collect({ ...ctx, useResume: true, prompt: "next" })))[0]?.result).toBe(
      "warm reply",
    );
  },
);

it.each(["owned", "old-input", "cycle", "orphan"] as const)(
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
    } else if (exclusion === "cycle") {
      excluded.parent_task_id = descendant.task_id;
    } else {
      excluded.parent_task_id = "unknown-parent";
    }
    scenario.tasks.unshift(descendant, excluded);
    const records = await results(collect(await context(scenario)));
    expect(records.map((record) => record.result)).toEqual([
      "waiting",
      ...scenario.chain.map((id) => `${id} reply`),
    ]);
    expect(records.at(-1)).not.toHaveProperty("openclaw_interim_result");
  },
);

it("retires deep ancestry holds when the consumer cancels the stream", async () => {
  const ctx = await context({
    ...ancestryScenario([4, 3, 2, 1, 0], "local_agent"),
    stopAfterWaiting: true,
  });
  let sawWaiting = false;
  for await (const record of executeClaudeCli(withClaudeCliTestDeadline(ctx))) {
    if (record.type === "result") {
      expect(record).toMatchObject({ result: "waiting", openclaw_interim_result: true });
      sawWaiting = true;
      break;
    }
  }
  expect(sawWaiting).toBe(true);
  expect(ctx.liveSession?.current()).toBeUndefined();
});
