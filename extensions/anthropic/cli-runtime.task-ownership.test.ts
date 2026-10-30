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
  "holds a nested %s answer until its parent-lane result",
  async (childType) => {
    // Claude Code non-interactive routing: a subagent's task notifies that subagent
    // while it runs, and the parent stream only once it has ended.
    const fixture = String.raw`
import { createInterface } from "node:readline";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const agent = (task_id, parent_task_id) => ({ task_id, run_id: task_id + "-run", task_type: parent_task_id ? process.env.CHILD_TASK_TYPE : "local_agent",
  ...(parent_task_id ? { parent_task_id } : {}) });
const tasks = (...list) => send({ type: "system", subtype: "background_tasks_changed", tasks: list });
const started = (task) => send({ type: "system", subtype: "task_started", ...task, is_backgrounded: true,
  spawn_depth: task.parent_task_id ? 2 : 1, tool_use_id: "tool-" + task.task_id });
const notified = (task) => send({ type: "system", subtype: "task_notification", task_id: task.task_id,
  run_id: task.run_id, status: "completed", output_file: "", summary: task.task_id });
const receipt = (task) => send({ type: "user", isReplay: true, parent_tool_use_id: null, uuid: "receipt-" + task.task_id,
  origin: { kind: "task-notification" }, message: { role: "user",
    content: "<task-notification>\n<task-id>" + task.task_id + "</task-id>\n<status>completed</status>\n</task-notification>" } });
const result = (answer, task) => send({ type: "result", subtype: "success", is_error: false, session_id: "fixture-session",
  result: JSON.stringify({ answer, pid: process.pid }), num_turns: 1, stop_reason: "end_turn",
  ...(task ? { origin: { kind: "task-notification", producer: "session-task", runId: task.run_id } } : {}) });
let input = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } });
    send({ type: "system", subtype: "init", capabilities: ["msg_lifecycle_v1"] });
    continue;
  }
  input++;
  send({ type: "command_lifecycle", state: "started", command_uuid: message.uuid });
  const outer = agent("outer-" + input);
  const inner = agent("inner-" + input, outer.task_id);
  tasks(outer);
  started(outer);
  result("launched");
  tasks(outer, inner);
  started(inner);
  if (input === 1) {
    // The running outer agent consumes this notification; no parent receipt or result follows.
    notified(inner);
    tasks(outer);
    tasks();
    notified(outer);
    receipt(outer);
    result("final", outer);
  } else {
    tasks(inner);
    notified(outer);
    receipt(outer);
    result("outer reported", outer);
    tasks();
    notified(inner);
    receipt(inner);
    result("final", inner);
  }
}
`;
    const liveSession = createLiveSession();
    const context = await harness.context(fixture, { liveSession }, { CHILD_TASK_TYPE: childType });
    const turns: Record<string, unknown>[][] = [];
    for (const prompt of ["subagent answers", "subagent ended first"]) {
      const answers: Record<string, unknown>[] = [];
      for await (const record of executeClaudeCli({
        ...context,
        prompt,
        useResume: turns.length > 0,
      })) {
        if (record.type !== "result") {
          continue;
        }
        const detail = JSON.parse(String(record.result)) as Record<string, unknown>;
        // A wrongly held final answer leaves the iterator open; check each result as it arrives.
        expect(record.openclaw_interim_result).toBe(detail.answer === "final" ? undefined : true);
        answers.push(detail);
      }
      expect(liveSession.current()?.isIdle()).toBe(true);
      turns.push(answers);
    }
    expect(turns.map((answers) => answers.map((detail) => detail.answer))).toEqual([
      ["launched", "final"],
      ["launched", "outer reported", "final"],
    ]);
    expect(turns[1]?.[0]?.pid).toBe(turns[0]?.[0]?.pid);
  },
);

it("never lends a later warm turn to a descendant that outlived its foreground parent", async () => {
  // Claude Code 2.1.310 reparents a nested background Agent when its foreground parent
  // finishes; the main answer can arrive while that descendant still runs.
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
    const child = { task_id: "child", task_type: "local_agent", parent_task_id: "parent" };
    system("task_started", { task_id: "parent", task_type: "local_agent", is_backgrounded: false });
    system("background_tasks_changed", { tasks: [child] });
    system("task_started", { ...child, is_backgrounded: true });
    system("task_notification", { task_id: "parent", status: "completed" });
    system("background_tasks_changed", { tasks: [{ task_id: "child", task_type: "local_agent" }] });
    send({ type: "command_lifecycle", state: "completed", command_uuid: message.uuid });
    result("parent final");
  }
}
`;
  const liveSession = createLiveSession();
  const context = await harness.context(fixture, { liveSession });
  const first = resultDetail(await collect(context));
  expect(first.answer).toBe("parent final");
  expect(liveSession.current()).toBeUndefined();
  // The next turn starts a fresh process; that process's descendant still runs, too.
  const next = resultDetail(await collect({ ...context, useResume: true }));
  expect(next).toMatchObject({ answer: "parent final" });
  expect(next.pid).not.toBe(first.pid);
});
