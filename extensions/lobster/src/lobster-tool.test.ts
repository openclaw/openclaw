import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { createEmbeddedLobsterRunner } from "./lobster-runner.js";
import { createLobsterTool } from "./lobster-tool.js";

vi.mock("./lobster-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lobster-runner.js")>();
  return { ...actual, createEmbeddedLobsterRunner: vi.fn(actual.createEmbeddedLobsterRunner) };
});

afterEach(() => {
  vi.mocked(createEmbeddedLobsterRunner).mockReset();
  vi.unstubAllEnvs();
});

const requireRecord = createRequireRecord("record", "expected-label-record");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resumeToken(details: unknown, field = "requiresInput") {
  const envelope = requireRecord(details, "Lobster envelope");
  const request = requireRecord(envelope[field], field);
  if (typeof request.resumeToken !== "string") {
    throw new Error("expected a resume token");
  }
  return request.resumeToken;
}

describe("lobster plugin tool", () => {
  let tool: ReturnType<typeof createLobsterTool>;
  beforeEach(() => {
    tool = createLobsterTool(createTestPluginApi());
  });
  const run = async (pipeline: string) =>
    (await tool.execute("run", { action: "run", pipeline })).details;
  const resume = async (
    token: string,
    decision: { responseJson?: string; approve?: boolean; cancel?: boolean },
  ) => (await tool.execute("resume", { action: "resume", token, ...decision })).details;
  const stateDir = (prefix: string) => {
    const dir = tempDirs.make(prefix);
    vi.stubEnv("LOBSTER_STATE_DIR", dir);
    return dir;
  };

  it("resumes real pipeline input, preserves invalid answers, and still handles approvals", async () => {
    stateDir("openclaw-lobster-input-");
    const first = await run('ask --prompt "Review draft?" | approve --prompt "Publish?"');
    expect(first).toMatchObject({
      status: "needs_input",
      requiresInput: { type: "input_request", prompt: "Review draft?" },
    });
    const token = resumeToken(first);
    await expect(resume(token, { responseJson: '{"decision":123}' })).rejects.toThrow(
      /schema validation/,
    );
    const second = await resume(token, {
      responseJson: '{"decision":"approve","feedback":"Looks good"}',
    });
    expect(second).toMatchObject({ status: "needs_approval" });
    const approved = await resume(resumeToken(second, "requiresApproval"), { approve: true });
    expect(approved).toMatchObject({
      status: "ok",
      output: [{ decision: "approve", feedback: "Looks good" }],
    });
    await expect(resume(token, { responseJson: '{"decision":"reject"}' })).rejects.toThrow(
      /not found/i,
    );
  });

  it("resumes real workflow files through successive questions without repeating preparation", async () => {
    const dir = stateDir("openclaw-lobster-workflow-input-");
    const seed = path.join(dir, "seed.json");
    await fs.writeFile(seed, JSON.stringify({ draft: "original" }));
    const file = path.join(dir, "review.lobster");
    await fs.writeFile(
      file,
      JSON.stringify({
        steps: [
          { id: "prepare", pipeline: "state.get seed | state.set prepared" },
          {
            id: "review",
            input: {
              prompt: "Review draft?",
              responseSchema: {
                type: "object",
                properties: { feedback: { type: "string" } },
                required: ["feedback"],
              },
              defaults: { feedback: "" },
            },
          },
          {
            id: "confirm",
            input: {
              prompt: "Which label?",
              responseSchema: { type: "string" },
            },
          },
          { id: "finish", pipeline: "state.get prepared" },
        ],
      }),
    );
    const first = await run(file);
    expect(first).toMatchObject({
      status: "needs_input",
      requiresInput: { defaults: { feedback: "" }, subject: { draft: "original" } },
    });
    await fs.writeFile(seed, JSON.stringify({ draft: "changed" }));
    const second = await resume(resumeToken(first), { responseJson: '{"feedback":"Keep it"}' });
    expect(second).toMatchObject({
      status: "needs_input",
      requiresInput: { prompt: "Which label?" },
    });
    // A new tool instance proves continuation comes from saved state, not the runner's memory.
    const finished = await createLobsterTool(createTestPluginApi()).execute("finish", {
      action: "resume",
      token: resumeToken(second),
      responseJson: '"reviewed"',
    });
    expect(finished.details).toMatchObject({ status: "ok", output: [{ draft: "original" }] });
  });

  it("cancels a real input checkpoint without executing its remaining steps", async () => {
    const dir = stateDir("openclaw-lobster-input-cancel-");
    const token = resumeToken(await run("ask | state.set should-not-exist"));
    expect(await resume(token, { cancel: true })).toMatchObject({ status: "cancelled" });
    await expect(fs.stat(path.join(dir, "should-not-exist.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(resume(token, { responseJson: '{"decision":"approve"}' })).rejects.toThrow(
      /not found/i,
    );
  });

  it("registers ordinary execution without a task runtime and keeps sandbox gating", () => {
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    plugin.register(createTestPluginApi({ registerTool }));
    const factory = registerTool.mock.calls[0]?.[0];
    if (typeof factory !== "function") {
      throw new Error("expected a registered Lobster tool factory");
    }
    expect(factory({ sandboxed: false })).toMatchObject({ name: "lobster" });
    expect(factory({ sandboxed: true })).toBeNull();
  });

  it("normalizes numeric string run limits before invoking the runner", async () => {
    const result = { ok: true, status: "ok", output: [], requiresApproval: null };
    const runner = { run: vi.fn().mockResolvedValue(result) };

    vi.mocked(createEmbeddedLobsterRunner).mockReturnValueOnce(runner);
    tool = createLobsterTool(createTestPluginApi());
    await tool.execute("call-string-limits", {
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      timeoutMs: "1500",
      maxStdoutBytes: "4096",
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      cwd: process.cwd(),
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["missing action", {}, /action required/],
    ["unknown action", { action: "explode" }, /Unknown action/],
    [
      "absolute cwd",
      { action: "run", pipeline: "noop", cwd: "/tmp" },
      /cwd must be a relative path/,
    ],
    ["escaping cwd", { action: "run", pipeline: "noop", cwd: "../../etc" }, /must stay within/],
  ])("rejects %s", async (_name, params, error) => {
    await expect(tool.execute("invalid", params)).rejects.toThrow(error);
  });
});
