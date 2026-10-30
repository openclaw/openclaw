export const CLAUDE_PROTOCOL_FIXTURE = String.raw`
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
writeFileSync("fixture.pid", String(process.pid));
const scenario = process.env.CLAUDE_FIXTURE_SCENARIO;
const replayReceipts = process.env.CLAUDE_FIXTURE_REPLAY_RECEIPTS !== "0";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const request = (id, request) => send({ type: "control_request", request_id: id, request });
const system = (subtype, detail = {}) => send({ type: "system", subtype, ...detail });
const lifecycle = (state, command_uuid) => send({ type: "command_lifecycle", state, command_uuid });
const tasks = (tasks) => system("background_tasks_changed", { tasks });
const nativeResult = (result = "", fields = {}) => send({
  type: "result", subtype: "success", is_error: false, result, session_id: "fixture-session", ...fields,
});
const userRecord = (content, fields = {}) => send({ type: "user", message: { role: "user", content }, ...fields });
const hook = (id, name, input, tool_use_id) => request(id, {
  subtype: "hook_callback", callback_id: hooks[name][0].hookCallbackIds[0],
  input: { hook_event_name: name, ...input }, ...(tool_use_id ? { tool_use_id } : {}),
});
const preTool = (id, tool_name, tool_input, toolId, fields = {}) => hook(id, "PreToolUse", { tool_name, tool_input, ...fields }, toolId);
const permission = (id, tool_name, input, tool_use_id) => request(id, { subtype: "can_use_tool", tool_name, input, tool_use_id });
const ready = (name) => {
  writeFileSync(name, "ready");
  sendReceipt(path.join(process.cwd(), name), "ready");
};
const promptHook = (id, prompt) => hook(id, "UserPromptSubmit", { prompt });
let hooks;
let initialize;
let turn = 0;
let user;
let synthetic;
let privateContext;
let lateDecision;
let pendingInputUuid;
let firstInputUuid;
let injectedContext;
let injectedRerunContext;
const priorResponses = {};
const hostFrames = [];
let credentialProof;
let shutdownDescendant;
if (scenario === "shutdown-ignore" || scenario === "shutdown-eof") {
  if (scenario === "shutdown-ignore") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else {
    process.stdin.once("end", () => process.exit(0));
  }
  const descendant = spawn(process.execPath, ["-e",
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready");'],
    { stdio: ["ignore", "pipe", "ignore"] });
  await once(descendant.stdout, "data");
  descendant.stdout.destroy();
  descendant.unref();
  shutdownDescendant = descendant.pid;
}
if (scenario === "credential-tree") {
  const descriptor = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR ?? process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR;
  const bytes = readFileSync(process.platform === "win32" ? 3 : process.platform === "darwin" ? "/dev/fd/3" : "/proc/self/fd/3");
  assert.equal(readFileSync(3).length, 0);
  const text = bytes.toString("utf8");
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  credentialProof = { descriptor, digest: createHash("sha256").update(bytes).digest("hex"),
    credentialInArgs: process.argv.some((arg) => arg.includes(text)),
    credentialInEnv: Object.values(process.env).includes(text), descendantPid: descendant.pid };
  bytes.fill(0);
}
const questionInput = { questions: [{
  header: "Approach", question: "Which path should Claude take?",
  options: [{ label: "Shared flow", description: "Use the existing behavior." },
    { label: "Separate flow", description: "Use a different behavior." }],
  multiSelect: false,
}] };
const backgroundAgent = scenario === "background-success" || scenario.startsWith("background-agent-subagent-bash") || scenario.startsWith("background-parent-stopped-child");
const parentStopped = scenario.startsWith("background-parent-stopped-child");
const capturedStopped = scenario.startsWith("background-bash-captured-stopped");
const firstSeenBackground = scenario === "background-bash-first-seen" || capturedStopped;
const explicitBackground = process.env.CLAUDE_FIXTURE_EXPLICIT_BACKGROUND === "1";
const nativeToolName = scenario === "user-question" ? "AskUserQuestion" : scenario === "mcp-hook" ? "mcp__openclaw__message" : firstSeenBackground ? "Bash" : "Read";
const nativeToolInput = scenario === "user-question" ? questionInput : firstSeenBackground ? { command: "synthetic long command", run_in_background: explicitBackground } : { file_path: "fixture.txt" };
const stoppedFinalRun = scenario.endsWith("-run-ids") ? { run_id: "stopped-bash-run" } : {};
const stoppedFinalPreToolUse = (id, name, input) => preTool(id, name, input, id + "-tool", {
  cwd: process.cwd(), tool_use_id: id + "-tool",
});
const result = (detail = {}) => nativeResult(
  JSON.stringify({ pid: process.pid, turn, user, synthetic, privateContext, injectedRerunContext, initialize, hostFrames, argv: process.argv.slice(2), ...detail }), {
  ...(detail.injectedContext ? { user_message_uuid: pendingInputUuid } : {}),
  ...((!replayReceipts || scenario === "background-bash-overlap") && detail.finalBackgroundAnswer ? {
    origin: { kind: "task-notification", producer: "session-task" }, num_turns: 1, stop_reason: "end_turn",
  } : {}),
});
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  hostFrames.push(message.type === "control_request" ? message.type + ":" + message.request.subtype : message.type);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    initialize = message.request;
    hooks = initialize.hooks;
    if (scenario === "revoked-initialize") {
      ready("initialize.ready");
      while (!existsSync("initialize.release")) await delay(5);
    }
    assert.ok(hooks.PreToolUse[0].hookCallbackIds[0]);
    assert.ok(hooks.UserPromptSubmit[0].hookCallbackIds[0]);
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { commands: [], models: [] },
    } });
  } else if (message.type === "user") {
    assert.ok(hooks);
    turn++;
    user = message.message.content;
    synthetic = message.isSynthetic === true;
    writeFileSync("user.received", user);
    if (scenario === "revoked-prompt") {
      ready("prompt.ready");
      while (!existsSync("prompt.release")) await delay(5);
    }
    if ((capturedStopped || backgroundAgent) && turn > 1) {
      result();
      continue;
    }
    if (scenario.startsWith("late-child")) {
      // Captured Claude Code 2.1.289/2.1.296 order: the Agent returns once its child Bash
      // is auto-backgrounded; that child would finish during a later input and resume the Agent.
      // 2.1.296 adds run_id/origin.runId and parent_task_id; 2.1.289 has neither.
      const runIds = scenario.endsWith("-run-ids");
      const run = (id) => (runIds ? { run_id: id } : {});
      const agent = (id) => ({ task_id: "old-agent", task_type: "local_agent", ...run(id) });
      const child = { task_id: "old-child", task_type: "local_bash", ...run("child-run"),
        ...(runIds ? { parent_task_id: "old-agent" } : {}) };
      const notified = (task, status = "completed") => send({ type: "system", subtype: "task_notification",
        ...task, status, output_file: "", summary: task.task_id });
      const notificationResult = (runId, detail) => send({ type: "result", subtype: "success", is_error: false,
        num_turns: 1, stop_reason: "end_turn",
        origin: { kind: "task-notification", producer: "session-task", ...(runIds ? { runId } : {}) },
        result: JSON.stringify({ pid: process.pid, turn, ...detail }), session_id: "fixture-session" });
      const inputResult = (detail) => send({ type: "result", subtype: "success", is_error: false, num_turns: 2,
        stop_reason: "end_turn", user_message_uuid: message.uuid,
        result: JSON.stringify({ pid: process.pid, turn, user, ...detail }), session_id: "fixture-session" });
      send({ type: "command_lifecycle", state: "started", command_uuid: message.uuid });
      if (turn === 1) {
        send({ type: "system", subtype: "init", capabilities: ["msg_lifecycle_v1"] });
        send({ type: "system", subtype: "background_tasks_changed", tasks: [agent("agent-run-1")] });
        send({ type: "system", subtype: "task_started", ...agent("agent-run-1"), tool_use_id: "tool-agent", is_backgrounded: true });
        inputResult({ agentLaunched: true });
        send({ type: "system", subtype: "background_tasks_changed", tasks: [agent("agent-run-1"), child] });
        send({ type: "system", subtype: "task_started", ...child, tool_use_id: "tool-child",
          owned_by_subagent: true, is_backgrounded: true });
        notified(agent("agent-run-1"));
        send({ type: "system", subtype: "background_tasks_changed", tasks: [child] });
        notificationResult("agent-run-1", { childLaunched: true });
      }
      continue;
    }
    if (scenario.startsWith("background-agent-foreground-bash")) {
      // Captured 2.1.296 order: the parent's own foreground Bash reports a task notification
      // while a background Agent is still running, then the Agent's answer arrives.
      if (turn > 1) {
        result();
        continue;
      }
      const runIds = scenario.endsWith("-run-ids");
      const agent = { task_id: "background-agent", task_type: "local_agent", ...(runIds ? { run_id: "agent-run" } : {}) };
      const bash = { task_id: "foreground-bash", task_type: "local_bash", ...(runIds ? { run_id: "bash-run" } : {}) };
      send({ type: "system", subtype: "background_tasks_changed", tasks: [agent] });
      send({ type: "system", subtype: "task_started", ...agent, tool_use_id: "tool-agent", is_backgrounded: true });
      send({ type: "system", subtype: "task_started", ...bash, tool_use_id: "tool-bash", is_backgrounded: false });
      send({ type: "system", subtype: "task_notification", ...bash, status: "completed", output_file: "", summary: "parent job" });
      send({ type: "result", subtype: "success", is_error: false, num_turns: 3, result: "", session_id: "fixture-session" });
      request("foreground-release", { subtype: "can_use_tool", tool_name: "Read",
        input: { file_path: "fixture.txt" }, tool_use_id: "foreground-release" });
      continue;
    }
    if (scenario.startsWith("background-bash-stopped-final")) {
      // Captured 2.1.289/2.1.296 stop-work order: a foreground Bash is moved to the
      // background, TaskStop kills it, the turn keeps working and ends with one result.
      if (turn > 1) {
        result();
        continue;
      }
      stoppedFinalPreToolUse("stopped-final-bash", "Bash", { command: "synthetic long command", timeout: 15000 });
      continue;
    }
    if (scenario === "credential-tree") {
      system("fixture_credential", { pid: process.pid, ...credentialProof });
      continue;
    }
    if (scenario === "shutdown-ignore" || scenario === "shutdown-eof") {
      system("fixture_shutdown", { pid: process.pid, descendantPid: shutdownDescendant });
      continue;
    }
    if (scenario === "mcp-elicitation") {
      request("elicitation", { subtype: "elicitation", mcp_server_name: "fixture",
        message: "Choose a fixture option", requested_schema: { type: "object" } });
      continue;
    }
    if (scenario?.startsWith("steer-")) {
      if (turn === 1) {
        firstInputUuid = message.uuid;
        lifecycle("started", message.uuid);
        system("init", { capabilities: ["msg_lifecycle_v1"] });
        if (scenario === "steer-prompt-pending") continue;
        promptHook("admitted-context", user);
        continue;
      }
      pendingInputUuid = message.uuid;
      if (scenario === "steer-after-result") {
        result({ interim: true });
        lifecycle("completed", firstInputUuid);
      }
      if (scenario !== "steer-refused") lifecycle("queued", message.uuid);
      if (scenario === "steer-exit") {
        process.exit(1);
      }
      if (["steer-cancelled", "steer-discarded", "steer-refused", "steer-completed"].includes(scenario)) {
        // Terminal receipts may omit started; only completed proves consumption.
        result();
        lifecycle("completed", firstInputUuid);
        lifecycle(scenario.slice("steer-".length), message.uuid);
        continue;
      }
      promptHook("injected-context", user);
      continue;
    }
    if (scenario === "input-lifecycle") {
      if (turn > 1) {
        pendingInputUuid = message.uuid;
        nativeResult("stale replay", { is_error: undefined, user_message_uuid: "prior-turn" });
        lifecycle("started", "unrelated-uuid");
        send({ type: "stream_event", user_message_uuid: "prior-turn", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "stale text" } } });
        send({ type: "assistant", user_message_uuid: "prior-turn", message: { role: "assistant", content: [{ type: "text", text: "stale text" }] } });
        preTool("prior-pre", "Read", { file_path: "prior-turn.txt" }, "prior-tool");
        permission("prior-permission", "Read", { file_path: "prior-turn.txt" }, "prior-tool");
        promptHook("prior-context", "prior user input");
      } else {
        lifecycle("started", message.uuid);
        system("init", { capabilities: ["msg_lifecycle_v1"] });
        result({ matchedInputUuid: message.uuid });
      }
      continue;
    }
    if (scenario === "background-bash-late-approval" && turn > 1) {
      system("fixture_second_turn");
      if (lateDecision) result({ lateDecision });
      continue;
    }
    if (backgroundAgent) {
      send({ type: "system", subtype: "background_tasks_changed",
        tasks: [{ task_id: "background-agent", task_type: "local_agent" },
          ...(parentStopped ? [{ task_id: "live-sibling", task_type: "local_workflow" }] : [])] });
      send({ type: "result", subtype: "success", is_error: false, result: "", session_id: "fixture-session" });
      // Claude Code 2.1.289: a child's Bash reports on the main stream, owner only on its start.
      if (scenario !== "background-success") send({ type: "system", subtype: "task_started", task_id: "subagent-bash",
        task_type: "local_bash", is_backgrounded: false, owned_by_subagent: true, tool_use_id: "tool-subagent-bash" });
      request("background-release", { subtype: "can_use_tool", tool_name: "Read",
        input: { file_path: "fixture.txt" }, tool_use_id: "background-release" });
      continue;
    }
    if (["background-bash-success", "background-bash-batched", "background-bash-early", "background-bash-inline", "background-bash-overlap", "background-bash-late-approval"].includes(scenario) && (replayReceipts || turn === 1)) {
      const batched = scenario === "background-bash-batched";
      const overlap = scenario === "background-bash-overlap";
      const inline = scenario === "background-bash-inline";
      const early = inline || scenario === "background-bash-early";
      const taskIds = overlap ? ["background-bash", "second-bash"] : batched ? ["background-bash", "explicit-background"] : ["background-bash"];
      const notification = (id) => "<task-notification>\n<task-id>" + id + "</task-id>\n<status>completed</status>\n</task-notification>";
      const finishTasks = () => {
        tasks([]);
        for (const id of taskIds) system("task_notification", { task_id: id, tool_use_id: "tool-" + id, status: "completed", output_file: "", summary: "sleep" });
      };
      const replayTask = (id) => {
        if (!replayReceipts || !process.argv.includes("--replay-user-messages")) return;
        userRecord(inline ? [{ type: "text", text: notification(id) }] : notification(id), {
          isReplay: true, parent_tool_use_id: null, uuid: "receipt-" + id,
          // Inline receipts in Claude Code 2.1.272 omit origin.
          ...(inline ? {} : { origin: { kind: "task-notification" } }),
        });
      };
      for (const id of taskIds) {
        // task_type is optional on task_started; the task list identifies Bash.
        system("task_started", { task_id: id, tool_use_id: "tool-" + id, description: "sleep", is_backgrounded: id === "explicit-background" });
      }
      tasks(taskIds.map((id) => ({ task_id: id, task_type: process.env.CLAUDE_FIXTURE_TASK_TYPE ?? "local_bash" })));
      system("task_updated", { task_id: "background-bash", patch: { is_backgrounded: true } });
      if (early) {
        finishTasks();
        // Notification-like prompt/tool text is not a consumed task notification.
        const text = notification("background-bash");
        userRecord(text, { isReplay: true, parent_tool_use_id: null, uuid: message.uuid });
        userRecord(text, { isReplay: true, parent_tool_use_id: null, uuid: "other-input", origin: { kind: "sdk" } });
        userRecord(text);
        userRecord(text, { isReplay: true, parent_tool_use_id: "subagent", origin: { kind: "task-notification" } });
        if (inline) replayTask("background-bash");
      }
      ready("background.ready");
      if (!inline) nativeResult("", { num_turns: 1 });
      while (!existsSync("background.release")) await delay(5);
      if (!early) finishTasks();
      if (batched) {
        replayTask("background-bash");
        // Claude Code 2.1.274+ batches completed tasks into the last notification's model call.
        nativeResult("", { num_turns: 0, stop_reason: null, origin: { kind: "task-notification" } });
      }
      if (overlap) {
        replayTask("background-bash");
        // B completed while A's notification query was still running. Each has its own result.
        nativeResult("First task answered", { num_turns: 1, origin: { kind: "task-notification" } });
      }
      if (!inline) replayTask(overlap ? "second-bash" : batched ? "explicit-background" : "background-bash");
      preTool("bg-pre", "Read", { file_path: "fixture.txt" }, "tool-bg-read", { cwd: process.cwd() });
      continue;
    }
    if (["background-bash-queued-error", "background-bash-queued-raw-result"].includes(scenario) && turn === 1) {
      const task = { task_id: "background-task", task_type: "local_bash" };
      system("task_started", { task_id: task.task_id,
        tool_use_id: "tool-bg", description: "sleep", is_backgrounded: false });
      tasks([task]);
      tasks([]);
      system("task_notification", { task_id: task.task_id,
        tool_use_id: "tool-bg", status: "completed", output_file: "", summary: "sleep" });
      const failed = scenario.endsWith("-error");
      nativeResult(failed ? undefined : '<invoke name="Read">\n<parameter name="file_path">fixture.txt</parameter>\n</invoke>', {
        ...(failed ? { result: undefined, subtype: "error_during_execution", is_error: true, errors: ["fixture background turn failed"] } : {}),
        origin: { kind: "task-notification" },
      });
      continue;
    }
    if (scenario === "large-split-record") {
      const record = JSON.stringify({ type: "assistant", message: { role: "assistant",
        content: [{ type: "text", text: "🦞" + "x".repeat(300_000) + "🦞" }] } });
      const bytes = Buffer.from(record + "\n");
      const crab = bytes.indexOf(Buffer.from("🦞"));
      process.stdout.write(bytes.subarray(0, crab + 1));
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.write(bytes.subarray(crab + 1, crab + 3));
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.write(bytes.subarray(crab + 3));
      result();
      continue;
    }
    promptHook("prompt-" + turn, user);
  } else if (message.type === "control_response") {
    assert.equal(message.response.subtype, "success");
    const { request_id: id, response } = message.response;
    if (id === "admitted-context") {
      privateContext = response.hookSpecificOutput?.additionalContext;
      if (scenario.startsWith("steer-hook-")) {
        promptHook("admitted-rerun", user + " rewritten");
        continue;
      }
      ready("turn.ready");
    } else if (id === "admitted-rerun") {
      assert.equal(response.hookSpecificOutput?.additionalContext, privateContext);
      ready("turn.ready");
    } else if (id === "injected-context" || id === "injected-rerun") {
      if (id === "injected-context") {
        injectedContext = response;
        if (scenario.startsWith("steer-hook-")) {
          promptHook("injected-rerun", scenario === "steer-hook-rewrite" ? user + " rewritten" : user);
          continue;
        }
      } else {
        injectedRerunContext = response;
      }
      lifecycle("started", pendingInputUuid);
      if (scenario === "steer-after-result") {
        system("init", { capabilities: ["msg_lifecycle_v1"] });
      }
      send({ type: "stream_event", user_message_uuid: pendingInputUuid, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "steered" } } });
      send({ type: "assistant", user_message_uuid: pendingInputUuid, message: { role: "assistant", content: [{ type: "text", text: "steered" }] } });
      if (scenario.includes("notification-replay")) {
        tasks([{ task_id: "background-agent", task_type: "local_agent" }]);
        tasks([]);
        system("task_notification", { task_id: "background-agent", status: "completed" });
        const completedFirst = scenario === "steer-completed-notification-replay";
        if (completedFirst) lifecycle("completed", pendingInputUuid);
        // Native replays host input without origin; notification-looking text is still user input.
        userRecord(user, { isReplay: true, parent_tool_use_id: null, uuid: pendingInputUuid });
        result({ injectedContext });
        if (!completedFirst) lifecycle("completed", pendingInputUuid);
        userRecord(user, { isReplay: true, parent_tool_use_id: null, uuid: "real-background-receipt", origin: { kind: "task-notification" } });
        result({ injectedContext, finalBackgroundAnswer: true });
      } else if (scenario === "steer-merged") {
        lifecycle("completed", pendingInputUuid);
        result({ injectedContext });
        lifecycle("completed", firstInputUuid);
      } else {
        result({ injectedContext });
        if (scenario === "steer-idle-trailer") {
          system("session_state_changed", { state: "idle" });
        }
        lifecycle("completed", pendingInputUuid);
      }
    } else if (id === "background-release") {
      if (parentStopped) {
        tasks([{ task_id: "live-sibling", task_type: "local_workflow" }]);
        system("task_notification", { task_id: "background-agent", status: "stopped" });
        result({ parentStoppedWithLiveSibling: true });
      }
      if (scenario !== "background-success") {
        system("task_notification", { task_id: "subagent-bash", tool_use_id: "tool-subagent-bash",
          status: scenario.endsWith("-stopped") ? "stopped" : "completed", output_file: "", summary: "sleep" });
        result({ childSettledWithParentPending: true });
      }
      tasks([]);
      system("task_notification", { task_id: parentStopped ? "live-sibling" : "background-agent",
        status: "completed", output_file: "", summary: "agent finished" });
      nativeResult(JSON.stringify({ pid: process.pid, turn, finalBackgroundAnswer: true }),
        { origin: { kind: "task-notification" }, num_turns: 1, stop_reason: "end_turn" });
    } else if (id === "foreground-release") {
      const runIds = scenario.endsWith("-run-ids");
      system("task_notification", { task_id: "background-agent", ...(runIds ? { run_id: "agent-run" } : {}),
        status: "completed", output_file: "", summary: "agent finished" });
      tasks([]);
      nativeResult(JSON.stringify({ pid: process.pid, turn, finalBackgroundAnswer: true }), {
        origin: { kind: "task-notification", producer: "session-task", ...(runIds ? { runId: "agent-run" } : {}) },
        num_turns: 1, stop_reason: "end_turn",
      });
    } else if (id === "stopped-final-bash") {
      assert.equal(response.hookSpecificOutput.permissionDecision, "allow");
      const task = { task_id: "stopped-bash", task_type: "local_bash", ...stoppedFinalRun };
      if (scenario.includes("-slow")) {
        system("task_started", { ...task, tool_use_id: "stopped-final-bash-tool", is_backgrounded: false });
        tasks([task]);
        system("task_updated", { task_id: task.task_id, ...stoppedFinalRun, patch: { is_backgrounded: true } });
      } else {
        tasks([task]);
        system("task_started", { ...task, tool_use_id: "stopped-final-bash-tool", is_backgrounded: true });
      }
      stoppedFinalPreToolUse("stopped-final-stop", "TaskStop", { task_id: task.task_id });
    } else if (id === "stopped-final-stop") {
      assert.equal(response.hookSpecificOutput.permissionDecision, "allow");
      if (!scenario.endsWith("-run-ids")) tasks([]);
      system("task_updated", { task_id: "stopped-bash", ...stoppedFinalRun, patch: { status: "killed" } });
      system("task_notification", { task_id: "stopped-bash", ...stoppedFinalRun,
        tool_use_id: "stopped-final-bash-tool", status: "stopped" });
      if (scenario.endsWith("-run-ids")) tasks([]);
      stoppedFinalPreToolUse("stopped-final-work", "Bash", { command: "echo more work" });
    } else if (id === "stopped-final-work") {
      assert.equal(response.hookSpecificOutput.permissionDecision, "allow");
      send({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn",
        content: [{ type: "text", text: "Stopped Bash final answer" }] } });
      nativeResult(JSON.stringify({ pid: process.pid, turn, user, stoppedBashFinal: true }),
        { num_turns: 4, stop_reason: "end_turn", terminal_reason: "completed" });
    } else if (id === "elicitation") {
      result({ elicitation: response });
    } else if (id.startsWith("prior-")) {
      priorResponses[id] = response;
      if (Object.keys(priorResponses).length === 3) {
        lifecycle("started", pendingInputUuid);
        result({ matchedInputUuid: pendingInputUuid, priorResponses });
      }
    } else if (id === "late-approval") {
      lateDecision = response;
      if (turn === 2) result({ lateDecision });
    } else if (id === "prompt-" + turn) {
      privateContext = response.hookSpecificOutput?.additionalContext;
      preTool("pre-" + turn, nativeToolName, nativeToolInput, "tool-" + turn, { cwd: process.cwd(), tool_use_id: "tool-" + turn });
    } else if (id === "captured-second-bash") {
      assert.equal(response.behavior, "allow");
      const first = { task_id: "captured-first", task_type: "local_bash" };
      const second = { task_id: "captured-second", task_type: "local_bash" };
      tasks([first, second]);
      system("task_started", { ...second, tool_use_id: "captured-second-tool", is_backgrounded: true });
      permission("captured-release", "Read", { file_path: "fixture.txt" }, "captured-release");
    } else if (id === "captured-release") {
      permission("captured-stop-first", "TaskStop", { task_id: "captured-first" }, "captured-stop-first-tool");
    } else if (id === "captured-stop-first") {
      assert.equal(response.behavior, "allow");
      const second = { task_id: "captured-second", task_type: "local_bash" };
      tasks([second]);
      system("task_notification", { task_id: "captured-first", tool_use_id: "tool-" + turn, status: "stopped" });
      if (scenario.endsWith("-overlap")) {
        result({ firstTaskStopped: true });
        tasks([]);
        system("task_notification", { task_id: second.task_id, tool_use_id: "captured-second-tool", status: "completed" });
        nativeResult(JSON.stringify({ pid: process.pid, turn, capturedShapeAnswered: true }),
          { origin: { kind: "task-notification" }, num_turns: 1, stop_reason: "end_turn" });
      } else {
        permission("captured-stop-second", "TaskStop", { task_id: second.task_id }, "captured-stop-second-tool");
      }
    } else if (id === "captured-stop-second") {
      assert.equal(response.behavior, "allow");
      tasks([]);
      system("task_notification", { task_id: "captured-second", tool_use_id: "captured-second-tool", status: "stopped" });
      result({ capturedShapeAnswered: true });
    } else if (id === "bg-pre") {
      if (scenario === "background-bash-late-approval") {
        permission("late-approval", "Bash", { command: "echo late" }, "late-tool");
      }
      tasks([]);
      result({ finalBackgroundAnswer: true, notificationDecision: response });
    } else if (id === "pre-" + turn) {
      if (scenario === "revoked-approval" || scenario === "mcp-hook") {
        result({ hookDecision: response });
        continue;
      }
      assert.equal(response.hookSpecificOutput.permissionDecision, scenario === "user-question" || firstSeenBackground ? "allow" : "deny");
      permission("permission-" + turn, nativeToolName, nativeToolInput, "tool-" + turn);
    } else if (id === "permission-" + turn) {
      assert.equal(response.behavior, scenario === "user-question" || firstSeenBackground ? "allow" : "deny");
      if (capturedStopped) {
        const task = { task_id: "captured-first", task_type: "local_bash" };
        // Exact 2.1.286 order: task list first, then already-backgrounded start.
        send({ type: "system", subtype: "background_tasks_changed", tasks: [task] });
        send({ type: "system", subtype: "task_started", ...task, tool_use_id: "tool-" + turn, is_backgrounded: true });
        request("captured-second-bash", { subtype: "can_use_tool", tool_name: "Bash", input: nativeToolInput, tool_use_id: "captured-second-tool" });
        continue;
      }
      if (firstSeenBackground) {
        const task = { task_id: "first-seen-" + turn, task_type: "local_bash" };
        // Native can first publish an automatic timeout as already backgrounded.
        tasks([task]);
        system("task_started", { ...task, tool_use_id: "tool-" + turn, is_backgrounded: true });
        result({ firstSeenBackground: true });
        if (!explicitBackground) {
          tasks([]);
          system("task_notification", { task_id: task.task_id, status: "completed" });
          nativeResult(JSON.stringify({ pid: process.pid, turn, finalBackgroundAnswer: true }), { origin: { kind: "task-notification" }, num_turns: 1 });
        }
        continue;
      }
      if (scenario === "cancel-permission") {
        permission("cancel-me", "Read", { file_path: "cancel.txt" }, "cancel-tool");
        setTimeout(() => send({ type: "control_cancel_request", request_id: "cancel-me" }), 20);
      } else result({ permission: response });
    } else if (id === "cancel-me") {
      assert.equal(response.behavior, "deny");
      result({ cancelledDecision: response });
    } else throw new Error("Unexpected fixture response: " + id);
  } else throw new Error("Unexpected fixture message: " + message.type);
}
`;
