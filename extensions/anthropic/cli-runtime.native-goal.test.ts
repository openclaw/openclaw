import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessNativeGoal } from "openclaw/plugin-sdk/cli-backend";
import { afterEach, expect, it } from "vitest";
import {
  collectClaudeCli,
  createCliTestHarness,
  waitForProcessExit,
  withClaudeCliTestDeadline,
} from "./cli-runtime.test-support.js";
import type { ClaudeCliExecuteContext } from "./cli-runtime.types.js";
import { CLAUDE_RESTRICTED_SETTINGS } from "./cli-shared.js";
import { executeClaudeCli } from "./cli.runtime.js";

const harness = createCliTestHarness("openclaw-claude-native-goal-");
afterEach(() => harness.cleanup());
const objective = "Verify the deliverable";
const sessionId = "126b5f07-071e-42d5-8d9e-c352c2df9fab";

// Captured 2.1.318 stream-json + session-mirror contract. The subprocess performs
// two native iterations under one input and emits the verdict after its result.
const fixture = String.raw`
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const scenario = process.env.SCENARIO;
assert(!process.argv.includes("--disable-slash-commands"));
assert(process.argv.includes("--session-mirror"));
assert.equal(process.argv[process.argv.indexOf("--setting-sources")+1], "");
const settings = JSON.parse(process.argv[process.argv.indexOf("--settings")+1]);
assert.equal(settings.disableAllHooks, false);
assert.deepEqual(settings.hooks, {});
assert.equal(settings.disableBundledSkills, true);
assert.equal(settings.disableSkillShellExecution, true);
const sessionId = "126b5f07-071e-42d5-8d9e-c352c2df9fab";
const mirror = attachment => send({type:"transcript_mirror", entries:[{type:"attachment", sessionId, attachment:{type:"goal_status",condition:"Verify the deliverable",...attachment}}]});
let input;
for await (const line of createInterface({input:process.stdin})) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({type:"control_response", response:{subtype:"success", request_id:message.request_id, response:{claude_code_version:process.env.NATIVE_VERSION || "2.1.318"}}});
  } else if (message.type === "user") {
    assert.equal(input, undefined, "host must not reprompt between native iterations");
    input = message.message.content;
    assert.equal(input, scenario === "resume" ? "Continue the existing work" : "/goal Verify the deliverable");
    send({type:"system",subtype:"init",session_id:sessionId});
    mirror({met:false,sentinel:true});
    send({type:"system",subtype:"fixture_ready",pid:process.pid});
    send({type:"control_request",request_id:"tool-1",request:{subtype:"can_use_tool",tool_name:"Read",input:{file_path:"first"}}});
  } else if (message.type === "control_response" && message.response.request_id === "tool-1") {
    assert.equal(message.response.response.behavior,"allow");
    send({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"First native iteration"}]}});
    send({type:"control_request",request_id:"tool-2",request:{subtype:"can_use_tool",tool_name:"Read",input:{file_path:"second"}}});
  } else if (message.type === "control_response" && message.response.request_id === "tool-2") {
    assert.equal(message.response.response.behavior,"allow");
    send({type:"result",subtype:scenario === "error" ? "error_during_execution" : "success",is_error:scenario === "error",result:"Finished native pursuit",session_id:sessionId});
    if (scenario === "reader-failure") {
      send({type:"transcript_mirror", entries:[], padding:"x".repeat(8 * 1024 * 1024)});
      continue;
    }
    if (scenario !== "unknown") mirror({met:scenario !== "failed" && scenario !== "active",failed:scenario === "failed",sentinel:scenario === "cleared",reason:"native verdict"});
  }
}
`;

async function setup(scenario = "complete") {
  const statuses: Parameters<AgentHarnessNativeGoal["onStatus"]>[0][] = [];
  const tools: string[] = [];
  const goalController = new AbortController();
  const native: AgentHarnessNativeGoal = {
    version: 1,
    signal: goalController.signal,
    id: "host-goal",
    objective,
    assertCurrent() {},
    async onStatus(status) {
      statuses.push(status);
    },
  };
  const context: ClaudeCliExecuteContext = await harness.context(
    fixture,
    {
      sessionId,
      prompt: "Continue the existing work",
      liveSession: harness.liveSession(),
      prepareNativeGoal: async () => native,
      requestToolPermission: async ({ toolInput }) => {
        tools.push(String(toolInput.file_path));
        return { behavior: "allow", updatedInput: toolInput };
      },
    },
    { SCENARIO: scenario },
  );
  context.args = [
    ...context.args,
    "--settings",
    CLAUDE_RESTRICTED_SETTINGS,
    "--setting-sources",
    "",
    "--disable-slash-commands",
  ];
  return { context, native, statuses, tools, goalController };
}

it.each([
  ["complete", "complete"],
  ["failed", "blocked"],
  ["active", "paused"],
  ["cleared", "paused"],
] as const)("settles a native %s verdict only after process exit", async (scenario, status) => {
  const f = await setup(scenario);
  let pid: number | undefined;
  const results: unknown[] = [];
  for await (const row of executeClaudeCli(withClaudeCliTestDeadline(f.context))) {
    if (row.subtype === "fixture_ready") {
      pid = Number(row.pid);
    }
    if (row.type === "result") {
      expect(f.statuses).toEqual([{ status, reason: "native verdict" }]);
      results.push(row);
    }
  }
  expect(results).toHaveLength(1);
  expect(f.tools).toEqual(["first", "second"]);
  expect(f.context.liveSession!.current()).toBeUndefined();
  assert(pid !== undefined);
  await waitForProcessExit([pid], AbortSignal.timeout(10_000));
});

it("does not mistake a successful result with an active goal for completion", async () => {
  const f = await setup("unknown");
  await collectClaudeCli(f.context);
  expect(f.statuses).toEqual([
    { status: "paused", reason: "Claude's native pursuit stopped before confirming the goal." },
  ]);
});

it("stops the complete pursuit on user cancellation without committing completion", async () => {
  const f = await setup();
  const controller = new AbortController();
  f.context.abortSignal = controller.signal;
  await expect(
    (async () => {
      for await (const row of executeClaudeCli(withClaudeCliTestDeadline(f.context))) {
        if (row.subtype === "fixture_ready") {
          controller.abort(new Error("user stopped"));
        }
      }
    })(),
  ).rejects.toThrow("user stopped");
  expect(f.statuses).toEqual([]);
  expect(f.context.liveSession!.current()).toBeUndefined();
});

it("retires the native process when goal custody is paused without aborting the host run", async () => {
  const f = await setup();
  let pid: number | undefined;
  await expect(
    (async () => {
      for await (const row of executeClaudeCli(withClaudeCliTestDeadline(f.context))) {
        if (row.subtype === "fixture_ready") {
          pid = Number(row.pid);
          f.goalController.abort(new Error("goal paused"));
        }
      }
    })(),
  ).rejects.toThrow("goal paused");
  expect(f.statuses).toEqual([]);
  expect(f.context.liveSession!.current()).toBeUndefined();
  assert(pid !== undefined);
  await waitForProcessExit([pid], AbortSignal.timeout(10_000));
});

it("does not mark a goal complete when the invocation fails after a native verdict", async () => {
  const f = await setup("error");
  await collectClaudeCli(f.context);
  expect(f.statuses).toEqual([
    { status: "paused", reason: "Claude's native pursuit ended with an invocation error." },
  ]);
});

it("does not commit a native verdict after late output projection fails", async () => {
  const f = await setup("reader-failure");
  const results: unknown[] = [];
  await expect(
    (async () => {
      for await (const row of executeClaudeCli(withClaudeCliTestDeadline(f.context))) {
        if (row.type === "result") {
          results.push(row);
        }
      }
    })(),
  ).rejects.toThrow("JSONL line exceeded");
  expect(f.statuses).toEqual([]);
  expect(results).toEqual([]);
  expect(f.context.liveSession!.current()).toBeUndefined();
});

it.each(["2.1.317", "unrecognized"])(
  "rejects an unqualified execution process version (%s) before sending the goal",
  async (version) => {
    const f = await setup();
    f.context.env.NATIVE_VERSION = version;
    const output: unknown[] = [];
    await expect(
      (async () => {
        for await (const row of executeClaudeCli(withClaudeCliTestDeadline(f.context))) {
          output.push(row);
        }
      })(),
    ).rejects.toThrow("verified initialization version");
    expect(output).toEqual([]);
    expect(f.tools).toEqual([]);
    expect(f.statuses).toEqual([]);
    expect(f.context.liveSession!.current()).toBeUndefined();
  },
);

it.each([false, true])(
  "reconciles the existing native objective before resume (foreign=%s)",
  async (foreign) => {
    const f = await setup("resume");
    const project = path.join(f.context.env.CLAUDE_CONFIG_DIR!, "projects", "fixture");
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, `${sessionId}.jsonl`),
      [
        {
          type: "user",
          sessionId,
          entrypoint: "sdk-cli",
          cwd: f.context.cwd,
          message: { role: "user", content: "Original task" },
        },
        {
          type: "attachment",
          sessionId,
          attachment: {
            type: "goal_status",
            condition: foreign ? "Another objective" : objective,
            met: false,
            sentinel: true,
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    f.context.useResume = true;
    const run = async () => {
      await collectClaudeCli(f.context);
    };
    if (foreign) {
      await expect(run()).rejects.toThrow("different native goal");
      expect(f.tools).toEqual([]);
      expect(f.statuses).toEqual([]);
    } else {
      await run();
      expect(f.statuses).toEqual([{ status: "complete", reason: "native verdict" }]);
    }
  },
);
