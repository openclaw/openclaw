import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { buildAgentInternalEventContext } from "../internal-events.js";
import { prepareCliTurnPromptContext } from "./prompt-context.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

// Native Claude caps each hook value independently after decoding stream-json.
const CLI = String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let callbacks = [];
const values = new Map();
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    callbacks = message.request.hooks.UserPromptSubmit[0].hookCallbackIds;
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "user") {
    for (const callback_id of callbacks) {
      send({ type: "control_request", request_id: callback_id, request: {
        subtype: "hook_callback", callback_id,
        input: { hook_event_name: "UserPromptSubmit", prompt: message.message.content },
      } });
    }
  } else if (message.type === "control_response") {
    values.set(message.response.request_id, message.response.response.hookSpecificOutput?.additionalContext ?? "");
    if (values.size !== callbacks.length) continue;
    const chunks = callbacks.map(id => values.get(id));
    send({ type: "system", subtype: "fixture_hook_lengths", lengths: chunks.map(value => value.length) });
    send({ type: "result", subtype: "success", is_error: false,
      result: chunks.map(value => value.length > 10_000 ? "Output too large.\n" + value.slice(0, 2_000) : value).join("") });
  }
}
`;

it.each([
  ["structured JSON", '{"k":"v"}\n'.repeat(15_000)],
  ["sixfold JSON escapes", "\u0000\ud800".repeat(79_990)],
])("delivers the full encoded %s child result through private hooks", async (_label, findings) => {
  const result = findings + "\t\\\nCHILD-RESULT-TAIL";
  expect(result.length).toBeLessThanOrEqual(160_000);
  const turn = await prepareCliTurnPromptContext({
    agentId: "main",
    backendId: "claude-cli",
    backend: { command: "claude", systemPromptArg: "--system-prompt" },
    systemPrompt: "Synthetic operator instructions.",
    prompt: "Continue the OpenClaw runtime event.",
    capabilityToolNames: new Set(["message"]),
    context: [],
    prependContext: [],
    privateContext: true,
    isNewSession: true,
    runtimeContextFragments: buildAgentInternalEventContext([
      {
        type: "task_completion",
        source: "subagent",
        childSessionKey: "agent:main:subagent:fixture",
        announceType: "task completion",
        taskLabel: "Synthetic findings",
        status: "ok",
        statusLabel: "completed successfully",
        result,
        replyInstruction: "Reply with the child findings.",
      },
    ]),
  });
  const expected = turn.promptContext?.appendContext;
  expect(expected?.length).toBeGreaterThan(200_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-completion-"));
  try {
    const fixture = path.join(root, "claude.mjs");
    await writeFile(fixture, CLI);
    const prepared = await buildAnthropicCliBackend().prepareExecution?.({
      workspaceDir: root,
      provider: "claude-cli",
      modelId: "fixture-model",
      executionMode: "agent",
    });
    const execute = expectDefined(prepared?.execute, "Claude native transport");
    const records = [];
    for await (const record of execute({
      ...turn,
      command: process.execPath,
      args: [fixture],
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: root, CLAUDE_CONFIG_DIR: root },
      modelId: "fixture-model",
      useResume: false,
      toolAvailability: { native: [], openClaw: ["message"] },
      timeoutMs: 10_000,
      requestToolPermission: async () => ({ behavior: "deny", message: "No tools in this probe." }),
      requestUserInput: async () => ({ status: "cancelled", message: "No input in this probe." }),
    })) {
      records.push(record);
    }
    const delivered = records.findLast((record) => record.type === "result")?.result;
    expect(delivered).toContain("CHILD-RESULT-TAIL");
    expect(delivered).toBe(expected);
    const lengths = records.find((record) => record.subtype === "fixture_hook_lengths")?.lengths;
    expect(lengths).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect((lengths as number[]).every((length) => length <= 10_000)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
