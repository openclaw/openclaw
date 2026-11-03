import type { CliBackendMessageInjection } from "openclaw/plugin-sdk/cli-backend";
import { expect, it } from "vitest";
import { collect, createContext, createLiveSession } from "./cli-runtime.protocol-test-harness.js";
import { resultDetail } from "./cli-runtime.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";

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
  const context = await createContext("custom", { liveSession, prompt: "first input" }, fixture);
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
  const context = await createContext("custom", { liveSession }, fixture);
  const first = resultDetail(await collect(context));
  expect(first.answer).toBe("parent final");
  expect(liveSession.current()).toBeUndefined();
  // The next turn starts a fresh process; that process's descendant still runs, too.
  const next = resultDetail(await collect({ ...context, useResume: true }));
  expect(next).toMatchObject({ answer: "parent final" });
  expect(next.pid).not.toBe(first.pid);
});
