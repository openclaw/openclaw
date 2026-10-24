import type { CliBackendMessageInjection } from "openclaw/plugin-sdk/cli-backend";
import { afterEach, expect, it } from "vitest";
import {
  collectClaudeCli as collect,
  createCliTestHarness,
  resultDetail,
} from "./cli-runtime.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";

const harness = createCliTestHarness();
const createLiveSession = harness.liveSession.bind(harness);
afterEach(() => harness.cleanup());

it("keeps a held current-input answer when a prior task result arrives", async () => {
  const fixture = String.raw`
import { createInterface } from "node:readline";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const lifecycle = (state, uuid) => send({ type: "command_lifecycle", state, command_uuid: uuid });
const result = (answer, fields = {}) => send({
  type: "result", subtype: "success", is_error: false, session_id: "fixture-session",
  result: JSON.stringify({ answer }), num_turns: 1, stop_reason: "end_turn", ...fields,
});
let hooks, input = 0, rootUuid, injectedUuid;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    hooks = message.request.hooks;
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } });
    send({ type: "system", subtype: "init", capabilities: ["msg_lifecycle_v1"] });
  } else if (message.type === "user") {
    input++;
    lifecycle("started", message.uuid);
    if (input === 1) {
      send({ type: "system", subtype: "task_started", task_id: "prior-agent",
        run_id: "prior-run-1", task_type: "local_agent", is_backgrounded: false });
      send({ type: "system", subtype: "task_notification", task_id: "prior-agent", status: "completed" });
      lifecycle("completed", message.uuid);
      result("first");
    } else {
      if (input === 2) rootUuid = message.uuid;
      else injectedUuid = message.uuid;
      send({ type: "control_request", request_id: "prompt-" + input, request: {
        subtype: "hook_callback", callback_id: hooks.UserPromptSubmit[0].hookCallbackIds[0],
        input: { hook_event_name: "UserPromptSubmit", prompt: message.message.content },
      } });
    }
  } else if (message.response.request_id === "prompt-2") {
    send({ type: "system", subtype: "current_ready" });
  } else {
    result("current");
    send({ type: "system", subtype: "task_started", task_id: "prior-agent",
      run_id: "prior-run-2", task_type: "local_agent", is_backgrounded: true });
    send({ type: "system", subtype: "background_tasks_changed",
      tasks: [{ task_id: "prior-agent", task_type: "local_agent", run_id: "prior-run-2" }] });
    send({ type: "system", subtype: "task_notification", task_id: "prior-agent",
      run_id: "prior-run-2", status: "completed" });
    result("prior task", { origin: { kind: "task-notification", runId: "prior-run-2" } });
    lifecycle("completed", injectedUuid);
    lifecycle("completed", rootUuid);
  }
}
`;
  const liveSession = createLiveSession();
  const context = await harness.context(fixture, { liveSession, prompt: "first input" });
  expect(resultDetail(await collect(context))).toMatchObject({ answer: "first" });
  let injection: CliBackendMessageInjection | undefined;
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli({
    ...context,
    prompt: "current input",
    useResume: true,
    registerMessageInjection: (value) => {
      injection = value;
    },
  })) {
    records.push(record);
    if (record.subtype === "current_ready") {
      if (!injection) {
        throw new Error("Expected native message injection");
      }
      expect(injection.isAvailable()).toBe(true);
      await injection.queueMessage("current injected input", async (submit) => submit());
    }
  }
  const results = records.filter((record) => record.type === "result");
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ openclaw_interim_result: true });
  expect(results[1]).not.toHaveProperty("openclaw_interim_result");
  expect(resultDetail(records)).toMatchObject({ answer: "current" });
  expect(liveSession.current()?.isIdle()).toBe(true);
});

it.each(["local_agent", "local_workflow"])(
  "settles the parent without a nested %s parent-lane receipt",
  async (childType) => {
    const fixture = String.raw`
import { createInterface } from "node:readline";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const system = (subtype, fields) => send({ type: "system", subtype, ...fields });
const result = (answer) => send({ type: "result", subtype: "success", is_error: false,
  session_id: "fixture-session", result: JSON.stringify({ answer, pid: process.pid }),
  num_turns: 1, stop_reason: "end_turn" });
let input = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } });
    system("init", { capabilities: ["msg_lifecycle_v1"] });
  } else if (message.type === "user") {
    send({ type: "command_lifecycle", state: "started", command_uuid: message.uuid });
    if (++input > 1) {
      result("warm input");
      continue;
    }
    const parent = { task_id: "parent", task_type: "local_agent" };
    const child = { task_id: "child", task_type: process.env.CHILD_TASK_TYPE, parent_task_id: "parent" };
    system("background_tasks_changed", { tasks: [parent] });
    system("task_started", { ...parent, is_backgrounded: true });
    result("waiting for parent");
    // Native's process-wide level precedes task_started. Nested Agents have a
    // parent and depth, but unlike nested Bash they have no owned_by_subagent flag.
    system("background_tasks_changed", { tasks: [parent, child] });
    system("task_started", { ...child,
      ...(child.task_type === "local_agent" ? { spawn_depth: 2 } : {}), is_backgrounded: true });
    system("task_notification", { task_id: "child", status: "completed" });
    system("background_tasks_changed", { tasks: [parent] });
    system("task_notification", { task_id: "parent", status: "completed" });
    // Only the parent notification is consumed in the main query. The child's
    // receipt and answer belong to its launching agent, not this stream.
    send({ type: "user", isReplay: true, parent_tool_use_id: null,
      origin: { kind: "task-notification" }, message: { role: "user",
        content: "<task-notification><task-id>parent</task-id></task-notification>" } });
    system("background_tasks_changed", { tasks: [] });
    send({ type: "command_lifecycle", state: "completed", command_uuid: message.uuid });
    result("parent final");
  }
}
`;
    const liveSession = createLiveSession();
    const context = await harness.context(fixture, { liveSession }, { CHILD_TASK_TYPE: childType });
    const results: Record<string, unknown>[] = [];
    for await (const record of executeClaudeCli(context)) {
      if (record.type !== "result") {
        continue;
      }
      results.push(record);
      if (results.length === 1) {
        expect(record).toHaveProperty("openclaw_interim_result", true);
      } else {
        // Assert on delivery, not a timeout: the broken owner emits this final
        // answer as interim and then leaves its iterator open indefinitely.
        expect(record).not.toHaveProperty("openclaw_interim_result");
      }
    }
    expect(results).toHaveLength(2);
    const final = resultDetail(results);
    expect(final.answer).toBe("parent final");
    const handle = liveSession.current();
    expect(handle?.isIdle()).toBe(true);
    const next = resultDetail(await collect({ ...context, useResume: true }));
    expect(next).toMatchObject({ answer: "warm input", pid: final.pid });
    expect(liveSession.current()).toBe(handle);
  },
);
