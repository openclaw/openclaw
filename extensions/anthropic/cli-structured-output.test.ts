import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { afterEach, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { executeClaudeCli } from "./cli.runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const schema = {
  type: "object",
  properties: { answer: { type: "integer" } },
  required: ["answer"],
  additionalProperties: false,
};

// A real child speaks the installed native initialize/hook/result protocol.
const fixture = String.raw`
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const scenario = process.env.SCENARIO;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    writeFileSync("initialize.json", JSON.stringify({ ...message.request, argv: process.argv.slice(2) }));
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "user") {
    if (scenario === "revoked") writeFileSync("revoked", "yes");
    send({ type: "control_request", request_id: "output", request: {
      subtype: "hook_callback", callback_id: "PreToolUse", input: {
        hook_event_name: "PreToolUse", tool_name: scenario === "other-tool" ? "Bash" : "StructuredOutput",
        tool_input: scenario === "invalid" ? { answer: "wrong" } : { answer: 42 },
      }, tool_use_id: "output-tool",
    } });
  } else if (message.type === "control_response") {
    writeFileSync("permission.json", JSON.stringify(message.response));
    send({ type: "result", subtype: "success", is_error: false,
      result: "Here is the answer: prose must not become the structured decision.",
      ...(scenario === "missing" ? {} : { structured_output: scenario === "invalid" ? { answer: "wrong" } : { answer: 42 } }),
    });
  }
}
`;

async function run(scenario: string, enabled = true, isolated = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-structured-"));
  roots.push(root);
  const script = path.join(root, "fixture.mjs");
  await writeFile(script, fixture);
  const requestToolPermission = vi.fn(async () => ({
    behavior: "deny" as const,
    message: "denied",
  }));
  const context: CliBackendExecuteContext = {
    command: process.execPath,
    args: [
      script,
      "--json-schema",
      "configured-schema",
      ...(isolated
        ? [
            "--safe-mode",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--tools",
            "",
            "--max-turns",
            "1",
          ]
        : []),
    ],
    cwd: root,
    env: { SCENARIO: scenario },
    prompt: "Return the answer",
    systemPrompt: "Synthetic system",
    modelId: "fixture",
    useResume: false,
    executionMode: isolated ? "side-question" : "agent",
    timeoutMs: 5000,
    abortSignal: AbortSignal.timeout(5000),
    toolAvailability: { native: [], openClaw: [] },
    ...(enabled ? { outputJsonSchema: schema } : {}),
    assertCurrent: () => {
      if (existsSync(path.join(root, "revoked"))) {
        throw new Error("retired");
      }
    },
    requestToolPermission,
    requestUserInput: async () => ({ status: "cancelled", message: "not available" }),
  };
  const records: Record<string, unknown>[] = [];
  const pending = (async () => {
    for await (const record of executeClaudeCli(context)) {
      records.push(record);
    }
    return records;
  })();
  return { pending, root, requestToolPermission };
}

it.each([false, true])(
  "requests a native schema with zero action tools and selects the validated structured result (isolated=%s)",
  async (isolated) => {
    const runResult = await run("valid", true, isolated);
    const records = await runResult.pending;
    expect(
      JSON.parse(await readFile(path.join(runResult.root, "initialize.json"), "utf8")),
    ).toMatchObject({ jsonSchema: schema });
    expect(
      JSON.parse(await readFile(path.join(runResult.root, "permission.json"), "utf8")),
    ).toMatchObject({ response: { hookSpecificOutput: { permissionDecision: "allow" } } });
    expect(records.findLast((record) => record.type === "result")?.result).toBe('{"answer":42}');
    expect(
      JSON.parse(await readFile(path.join(runResult.root, "initialize.json"), "utf8")),
    ).toMatchObject({ argv: expect.not.arrayContaining(["configured-schema"]) });
    if (isolated) {
      const initialized = JSON.parse(
        await readFile(path.join(runResult.root, "initialize.json"), "utf8"),
      );
      expect(initialized.argv).toEqual(
        expect.arrayContaining(["--safe-mode", "--strict-mcp-config", "--no-session-persistence"]),
      );
      expect(initialized.argv).not.toContain("--session-id");
    }
    expect(runResult.requestToolPermission).not.toHaveBeenCalled();
  },
);

it.each(["invalid", "missing"])(
  "rejects %s structured output instead of falling back to prose",
  async (scenario) => {
    const result = await run(scenario);
    await expect(result.pending).rejects.toThrow("structured output");
    if (scenario === "invalid") {
      expect(
        JSON.parse(await readFile(path.join(result.root, "permission.json"), "utf8")),
      ).toMatchObject({ response: { hookSpecificOutput: { permissionDecision: "deny" } } });
    }
  },
);

it.each([
  { scenario: "valid", enabled: false },
  { scenario: "other-tool", enabled: true },
])(
  "does not grant ordinary native tools or unsolicited structured-output calls: $scenario/$enabled",
  async ({ scenario, enabled }) => {
    const result = await run(scenario, enabled);
    await result.pending;
    expect(result.requestToolPermission).toHaveBeenCalledOnce();
    expect(
      JSON.parse(await readFile(path.join(result.root, "permission.json"), "utf8")),
    ).toMatchObject({ response: { hookSpecificOutput: { permissionDecision: "deny" } } });
  },
);

it("does not grant terminal submission or accept its result after authority is revoked", async () => {
  const result = await run("revoked");
  await expect(result.pending).rejects.toThrow("retired");
  expect(
    JSON.parse(await readFile(path.join(result.root, "permission.json"), "utf8")),
  ).toMatchObject({ response: { hookSpecificOutput: { permissionDecision: "deny" } } });
});

it("selects schema transport for an isolated completion without changing ordinary isolated calls", () => {
  const backend = buildAnthropicCliBackend();
  const context = {
    workspaceDir: "/tmp/openclaw-claude-cli",
    provider: "claude-cli",
    modelId: "claude-opus-4-8",
    executionMode: "side-question" as const,
    isolatedCompletionPrompt: "Return a verdict",
    isolatedCompletionOutputJsonSchema: { type: "object" },
  };
  const prepared = backend.prepareExecution?.(context);
  expect(prepared).toMatchObject({
    isolatedCompletionEnforced: true,
    execute: expect.any(Function),
  });
  const ordinary = { ...context, isolatedCompletionOutputJsonSchema: undefined };
  expect(backend.prepareExecution?.(ordinary)).toEqual({
    env: {},
    isolatedCompletionEnforced: true,
  });
});
