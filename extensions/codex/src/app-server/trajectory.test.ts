import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTrajectoryRuntimeEvents } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexTrajectoryRecorder } from "./trajectory.js";

type CodexTrajectoryRecorder = NonNullable<ReturnType<typeof createCodexTrajectoryRecorder>>;

const tempDirs: string[] = [];
const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-trajectory-"));
  tempDirs.push(dir);
  return dir;
}

function useTempStateDir(): string {
  const dir = makeTempDir();
  process.env.OPENCLAW_STATE_DIR = dir;
  return dir;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function expectTrajectoryRecorder(
  recorder: ReturnType<typeof createCodexTrajectoryRecorder>,
): CodexTrajectoryRecorder {
  if (recorder === null) {
    throw new Error("Expected Codex trajectory recorder");
  }
  expect(typeof recorder.recordEvent).toBe("function");
  return recorder;
}

describe("Codex trajectory recorder", () => {
  it("records by default into the agent database unless explicitly disabled", async () => {
    const tmpDir = useTempStateDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        provider: "codex",
        modelId: "gpt-5.4",
        model: { api: "responses" },
      } as never,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started", {
      apiKey: "secret",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
    });
    await trajectoryRecorder.flush();

    const events = listTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session.started");
    expect(events[0]?.provider).toBe("codex");
    expect(events[0]?.modelId).toBe("gpt-5.4");
    expect(events[0]?.modelApi).toBe("responses");
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("sk-test-secret-token");
    expect(serialized).not.toContain("sk-other-secret-token");
    expect(serialized).toContain("Bearer <redacted>");
    expect(fs.existsSync(path.join(tmpDir, "session.trajectory.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "session.trajectory-path.json"))).toBe(false);
  });

  it("honors explicit disablement", () => {
    const tmpDir = useTempStateDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY: "0" },
    });

    expect(recorder).toBeNull();
    expect(listTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1" })).toEqual([]);
  });

  it("truncates events that exceed the runtime event byte limit", async () => {
    const tmpDir = useTempStateDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("context.compiled", {
      fields: Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [`field-${index}`, "x".repeat(5_000)]),
      ),
    });
    await trajectoryRecorder.flush();

    const [event] = listTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1" });
    expect(event?.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
    });
  });
});
