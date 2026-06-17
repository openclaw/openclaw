// Codex tests cover trajectory plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexTrajectoryRecorder,
  resolveCodexTrajectoryAppendFlags,
  resolveCodexTrajectoryRuntimeEventMaxBytes,
  resolveCodexTrajectoryPointerFlags,
} from "./trajectory.js";

type CodexTrajectoryRecorder = NonNullable<ReturnType<typeof createCodexTrajectoryRecorder>>;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-trajectory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
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
  it("keeps write flags usable when O_NOFOLLOW is unavailable", () => {
    const constants = {
      O_APPEND: 0x01,
      O_CREAT: 0x02,
      O_TRUNC: 0x04,
      O_WRONLY: 0x08,
    };

    expect(resolveCodexTrajectoryAppendFlags(constants)).toBe(0x0b);
    expect(resolveCodexTrajectoryPointerFlags(constants)).toBe(0x0e);
  });

  it("records by default unless explicitly disabled", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile,
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        provider: "codex",
        modelId: "gpt-5.4",
        model: { api: "responses" },
      } as never,
      env: {},
    });

    expect(recorder).not.toBeNull();
    recorder?.recordEvent("session.started", {
      apiKey: "secret",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
    });
    await recorder?.flush();

    const filePath = path.join(tmpDir, "session.trajectory.jsonl");
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain('"type":"session.started"');
    expect(content).not.toContain("secret");
    expect(content).not.toContain("sk-test-secret-token");
    expect(content).not.toContain("sk-other-secret-token");
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(path.join(tmpDir, "session.trajectory-path.json"))).toBe(true);
  });

  it("records canonical OpenAI Codex app-server turns with Codex local attribution", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile,
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-5.5",
        model: { provider: "openai", api: "openai-responses" },
        runtimePlan: {
          observability: {
            resolvedRef: "openai/gpt-5.5",
            provider: "openai",
            modelId: "gpt-5.5",
            harnessId: "codex",
          },
        },
      } as never,
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started");
    await trajectoryRecorder.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    );
    expect(parsed.provider).toBe("openai");
    expect(parsed.modelApi).toBe("openai-chatgpt-responses");
    expect(parsed.modelId).toBe("gpt-5.5");
  });

  it("sanitizes session ids when resolving an override directory", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "../evil/session",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY_DIR: tmpDir },
    });

    recorder?.recordEvent("session.started");
    await recorder?.flush();

    expect(fs.existsSync(path.join(tmpDir, "___evil_session.jsonl"))).toBe(true);
  });

  it("honors explicit disablement", () => {
    const tmpDir = makeTempDir();
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
  });

  it.runIf(process.platform !== "win32")(
    "refuses to append through a symlinked parent directory",
    async () => {
      const tmpDir = makeTempDir();
      const targetDir = path.join(tmpDir, "target");
      const linkDir = path.join(tmpDir, "link");
      fs.mkdirSync(targetDir);
      fs.symlinkSync(targetDir, linkDir);
      const recorder = createCodexTrajectoryRecorder({
        cwd: tmpDir,
        attempt: {
          sessionFile: path.join(linkDir, "session.jsonl"),
          sessionId: "session-1",
          model: { api: "responses" },
        } as never,
        env: {},
      });

      recorder?.recordEvent("session.started");
      await recorder?.flush();

      expect(fs.existsSync(path.join(targetDir, "session.trajectory.jsonl"))).toBe(false);
    },
  );

  it("honors OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES override", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "512" },
    });

    recorder?.recordEvent("context.compiled", {
      payload: "x".repeat(600),
    });
    await recorder?.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    ) as { data?: { truncated?: boolean; reason?: string } };
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
    });
  });

  it("clamps configured event caps to the append file budget", () => {
    expect(
      resolveCodexTrajectoryRuntimeEventMaxBytes(
        { OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "1mb" },
        1_024,
      ),
    ).toBe(1_023);
  });

  it("truncates events that exceed the runtime event byte limit", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: {},
    });

    recorder?.recordEvent("context.compiled", {
      fields: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`field-${index}`, "x".repeat(3_000)]),
      ),
    });
    await recorder?.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    ) as { data?: { truncated?: boolean; reason?: string } };
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
    });
  });

  it("accepts human-friendly byte-size suffixes for the event cap override", async () => {
    const tmpDir = makeTempDir();
    // 1kb = 1024 bytes — create an event between 600-1024 bytes to verify it is NOT truncated
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-suffix",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "1kb" },
    });

    recorder?.recordEvent("session.started", { payload: "x".repeat(600) });
    await recorder?.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    ) as { data?: { truncated?: boolean } };
    expect(parsed.data?.truncated).not.toBe(true);
  });

  it("falls back to default on invalid suffix values", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-invalid-suffix",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: "abc-not-a-size" },
    });

    // Invalid value falls back to default 262144 bytes — a small event should pass through without truncation
    recorder?.recordEvent("session.started", { payload: "small" });
    await recorder?.flush();

    const content = fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8");
    expect(content).toContain('"type":"session.started"');
    expect(content).not.toContain('"truncated"');
  });
});
