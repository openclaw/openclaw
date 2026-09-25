export const CLAUDE_PROTOCOL_FIXTURE = String.raw`
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
writeFileSync("fixture.pid", String(process.pid));
const scenario = process.env.CLAUDE_FIXTURE_SCENARIO;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const request = (id, request) => send({ type: "control_request", request_id: id, request });
let hooks;
let initialize;
let turn = 0;
let user;
let privateContext;
let lateDecision;
let pendingInputUuid;
const priorResponses = {};
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
const result = (detail = {}) => send({
  type: "result", subtype: "success", is_error: false,
  result: JSON.stringify({ pid: process.pid, turn, user, privateContext, initialize, argv: process.argv.slice(2), ...detail }),
  session_id: "fixture-session",
});
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    initialize = message.request;
    hooks = initialize.hooks;
    if (scenario === "revoked-initialize") {
      writeFileSync("initialize.ready", "ready");
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
    writeFileSync("user.received", user);
    if (scenario === "credential-tree") {
      send({ type: "system", subtype: "fixture_credential", pid: process.pid, ...credentialProof });
      continue;
    }
    if (scenario === "shutdown-ignore" || scenario === "shutdown-eof") {
      send({ type: "system", subtype: "fixture_shutdown", pid: process.pid, descendantPid: shutdownDescendant });
      continue;
    }
    if (scenario === "stream-then-wait") {
      send({ type: "system", subtype: "fixture_waiting", pid: process.pid });
      continue;
    }
    if (scenario === "mcp-elicitation") {
      request("elicitation", { subtype: "elicitation", mcp_server_name: "fixture",
        message: "Choose a fixture option", requested_schema: { type: "object" } });
      continue;
    }
    if (scenario === "input-lifecycle") {
      if (turn > 1) {
        pendingInputUuid = message.uuid;
        send({ type: "result", subtype: "success", result: "stale replay", session_id: "fixture-session" });
        send({ type: "command_lifecycle", state: "started", command_uuid: "unrelated-uuid" });
        send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "stale text" }] } });
        request("prior-pre", { subtype: "hook_callback", callback_id: hooks.PreToolUse[0].hookCallbackIds[0],
          input: { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "prior-turn.txt" } },
          tool_use_id: "prior-tool" });
        request("prior-permission", { subtype: "can_use_tool", tool_name: "Read",
          input: { file_path: "prior-turn.txt" }, tool_use_id: "prior-tool" });
        request("prior-context", { subtype: "hook_callback", callback_id: hooks.UserPromptSubmit[0].hookCallbackIds[0],
          input: { hook_event_name: "UserPromptSubmit", prompt: "prior user input" } });
      } else {
        send({ type: "command_lifecycle", state: "started", command_uuid: message.uuid });
        send({ type: "system", subtype: "init", capabilities: ["msg_lifecycle_v1"] });
        result({ matchedInputUuid: message.uuid });
      }
      continue;
    }
    if (scenario === "late-approval") {
      if (turn === 1) {
        request("late-approval", { subtype: "can_use_tool", tool_name: "Bash",
          input: { command: "echo late" }, tool_use_id: "late-tool" });
        result();
      } else {
        send({ type: "system", subtype: "fixture_second_turn" });
        if (lateDecision) result({ lateDecision });
      }
      continue;
    }
    if (scenario === "missing-result") {
      process.stderr.write("PermissionError: fixture cannot read its input\n", () => process.exit(1));
      continue;
    }
    if (scenario === "ordinary-error") {
      if (turn === 1) {
        send({ type: "result", subtype: "error_during_execution", is_error: true,
          errors: ["fixture foreground turn failed"], session_id: "fixture-session" });
      } else result();
      continue;
    }
    if (scenario === "background-success") {
      send({ type: "system", subtype: "background_tasks_changed",
        tasks: [{ task_id: "background-agent", task_type: "local_agent" }] });
      send({ type: "result", subtype: "success", is_error: false, result: "", session_id: "fixture-session" });
      writeFileSync("background.ready", "ready");
      while (!existsSync("background.release")) await delay(5);
      send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      result({ finalBackgroundAnswer: true });
      continue;
    }
    if (["background-bash-success", "background-bash-batched", "background-bash-early", "background-bash-inline"].includes(scenario)) {
      const batched = scenario === "background-bash-batched";
      const inline = scenario === "background-bash-inline";
      const early = inline || scenario === "background-bash-early";
      const taskIds = batched ? ["background-bash", "explicit-background"] : ["background-bash"];
      const notification = (id) => "<task-notification>\n<task-id>" + id + "</task-id>\n<status>completed</status>\n</task-notification>";
      const finishTasks = () => {
        send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
        for (const id of taskIds) send({ type: "system", subtype: "task_notification", task_id: id,
          tool_use_id: "tool-" + id, status: "completed", output_file: "", summary: "sleep" });
      };
      const replayTask = (id) => {
        if (!process.argv.includes("--replay-user-messages")) return;
        send({ type: "user", isReplay: true, parent_tool_use_id: null, uuid: "receipt-" + id,
          // Inline receipts in Claude Code 2.1.272 omit origin.
          ...(inline ? {} : { origin: { kind: "task-notification" } }),
          message: { role: "user", content: inline ? [{ type: "text", text: notification(id) }] : notification(id) } });
      };
      for (const id of taskIds) {
        // task_type is optional on task_started; the task list identifies Bash.
        send({ type: "system", subtype: "task_started", task_id: id,
          tool_use_id: "tool-" + id, description: "sleep", is_backgrounded: id === "explicit-background" });
      }
      send({ type: "system", subtype: "background_tasks_changed",
        tasks: taskIds.map((id) => ({ task_id: id, task_type: "local_bash" })) });
      send({ type: "system", subtype: "task_updated", task_id: "background-bash",
        patch: { is_backgrounded: true } });
      if (early) {
        finishTasks();
        // Notification-like prompt/tool text is not a consumed task notification.
        send({ type: "user", isReplay: true, parent_tool_use_id: null, uuid: message.uuid,
          message: { role: "user", content: notification("background-bash") } });
        send({ type: "user", isReplay: true, parent_tool_use_id: null, uuid: "other-input", origin: { kind: "sdk" },
          message: { role: "user", content: notification("background-bash") } });
        send({ type: "user", message: { role: "user", content: notification("background-bash") } });
        send({ type: "user", isReplay: true, parent_tool_use_id: "subagent", origin: { kind: "task-notification" },
          message: { role: "user", content: notification("background-bash") } });
        if (inline) replayTask("background-bash");
      }
      if (!inline) send({ type: "result", subtype: "success", is_error: false, num_turns: 1,
        result: "", session_id: "fixture-session" });
      writeFileSync("background.ready", "ready");
      while (!existsSync("background.release")) await delay(5);
      if (!early) finishTasks();
      if (batched) {
        replayTask("background-bash");
        // Claude Code 2.1.274+ batches completed tasks into the last notification's model call.
        send({ type: "result", subtype: "success", is_error: false, num_turns: 0, stop_reason: null,
          origin: { kind: "task-notification" }, result: "", session_id: "fixture-session" });
      }
      if (!inline) replayTask(batched ? "explicit-background" : "background-bash");
      request("bg-pre", { subtype: "hook_callback",
        callback_id: hooks.PreToolUse[0].hookCallbackIds[0], tool_use_id: "tool-bg-read",
        input: { cwd: process.cwd(), hook_event_name: "PreToolUse", tool_name: "Read",
          tool_input: { file_path: "fixture.txt" } } });
      continue;
    }
    if (scenario === "background-bash-explicit") {
      // run_in_background: started already backgrounded, may never finish; not held.
      send({ type: "system", subtype: "task_started", task_id: "server",
        tool_use_id: "tool-bg", description: "dev server", is_backgrounded: true, task_type: "local_bash" });
      send({ type: "system", subtype: "background_tasks_changed",
        tasks: [{ task_id: "server", task_type: "local_bash" }] });
      result({ explicitBackground: true });
      continue;
    }
    if (["background-error", "background-raw-result", "background-bash-error", "background-bash-raw-result", "background-bash-queued-error"].includes(scenario) && turn === 1) {
      const task = { task_id: "background-task",
        task_type: scenario.startsWith("background-bash-") ? "local_bash" : "local_agent" };
      if (task.task_type === "local_bash") {
        send({ type: "system", subtype: "task_started", task_id: task.task_id,
          tool_use_id: "tool-bg", description: "sleep", is_backgrounded: false });
      }
      send({ type: "system", subtype: "background_tasks_changed",
        tasks: [task] });
      if (scenario === "background-bash-queued-error") {
        send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
        send({ type: "system", subtype: "task_notification", task_id: task.task_id,
          tool_use_id: "tool-bg", status: "completed", output_file: "", summary: "sleep" });
      }
      send(scenario.endsWith("-error")
        ? { type: "result", subtype: "error_during_execution", is_error: true,
            errors: ["fixture background turn failed"], session_id: "fixture-session" }
        : { type: "result", subtype: "success", is_error: false,
            result: '<invoke name="Read">\n<parameter name="file_path">fixture.txt</parameter>\n</invoke>',
            session_id: "fixture-session" });
      continue;
    }
    if (["background-error", "background-raw-result", "background-bash-error", "background-bash-raw-result", "background-bash-queued-error"].includes(scenario)) {
      send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      result();
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
    request("prompt-" + turn, { subtype: "hook_callback",
      callback_id: hooks.UserPromptSubmit[0].hookCallbackIds[0],
      input: { hook_event_name: "UserPromptSubmit", prompt: user } });
  } else if (message.type === "control_response") {
    assert.equal(message.response.subtype, "success");
    const { request_id: id, response } = message.response;
    if (id === "elicitation") {
      result({ elicitation: response });
    } else if (id.startsWith("prior-")) {
      priorResponses[id] = response;
      if (Object.keys(priorResponses).length === 3) {
        send({ type: "command_lifecycle", state: "started", command_uuid: pendingInputUuid });
        result({ matchedInputUuid: pendingInputUuid, priorResponses });
      }
    } else if (id === "late-approval") {
      lateDecision = response;
      if (turn === 2) result({ lateDecision });
    } else if (id === "prompt-" + turn) {
      privateContext = response.hookSpecificOutput?.additionalContext;
      request("pre-" + turn, { subtype: "hook_callback",
        callback_id: hooks.PreToolUse[0].hookCallbackIds[0], tool_use_id: "tool-" + turn,
        input: { cwd: process.cwd(), hook_event_name: "PreToolUse", tool_name: scenario === "user-question" ? "AskUserQuestion" : scenario === "mcp-hook" ? "mcp__openclaw__message" : "Read",
          tool_input: scenario === "user-question" ? questionInput : { file_path: "fixture.txt" },
          tool_use_id: "tool-" + turn } });
    } else if (id === "bg-pre") {
      send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      result({ finalBackgroundAnswer: true, notificationDecision: response });
    } else if (id === "pre-" + turn) {
      if (scenario === "revoked-approval") {
        result({ hookDecision: response });
        continue;
      }
      if (scenario === "mcp-hook") {
        result({ hookDecision: response });
        continue;
      }
      assert.equal(response.hookSpecificOutput.permissionDecision, scenario === "user-question" ? "allow" : "deny");
      request("permission-" + turn, { subtype: "can_use_tool",
        tool_name: scenario === "user-question" ? "AskUserQuestion" : "Read",
        input: scenario === "user-question" ? questionInput : { file_path: "fixture.txt" },
        tool_use_id: "tool-" + turn });
    } else if (id === "permission-" + turn) {
      assert.equal(response.behavior, scenario === "user-question" ? "allow" : "deny");
      if (scenario === "cancel-permission") {
        request("cancel-me", { subtype: "can_use_tool", tool_name: "Read",
          input: { file_path: "cancel.txt" }, tool_use_id: "cancel-tool" });
        setTimeout(() => send({ type: "control_cancel_request", request_id: "cancel-me" }), 20);
      } else result({ permission: response });
    } else if (id === "cancel-me") {
      assert.equal(response.behavior, "deny");
      result({ cancelledDecision: response });
    } else throw new Error("Unexpected fixture response: " + id);
  } else throw new Error("Unexpected fixture message: " + message.type);
}
`;
