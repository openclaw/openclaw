// Codex tests cover trajectory plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexTrajectoryRecorder,
  recordCodexTrajectoryContext,
  resolveCodexTrajectoryAppendFlags,
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

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started", {
      apiKey: "secret",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
    });
    await trajectoryRecorder.flush();

    const filePath = path.join(tmpDir, "session.trajectory.jsonl");
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain('"type":"session.started"');
    expect(content).not.toContain("secret");
    expect(content).not.toContain("sk-test-secret-token");
    expect(content).not.toContain("sk-other-secret-token");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
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

  it("records namespace dynamic tools as callable trajectory tool definitions", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const init = {
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
      tools: [
        {
          type: "namespace",
          name: "openclaw",
          description: "",
          tools: [
            {
              type: "function",
              name: "web_search",
              description: "Search the web.",
              inputSchema: { type: "object" },
              deferLoading: true,
            },
          ],
        },
      ],
    } satisfies Parameters<typeof createCodexTrajectoryRecorder>[0];
    const recorder = createCodexTrajectoryRecorder(init);

    recordCodexTrajectoryContext(expectTrajectoryRecorder(recorder), init);
    await recorder?.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    );
    expect(parsed.data?.tools).toEqual([
      {
        name: "web_search",
        description: "Search the web.",
        parameters: { type: "object" },
      },
    ]);
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

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started");
    await trajectoryRecorder.flush();

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

  it("refuses to append through a symlinked parent directory", async () => {
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

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started");
    await trajectoryRecorder.flush();

    expect(fs.existsSync(path.join(targetDir, "session.trajectory.jsonl"))).toBe(false);
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

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("context.compiled", {
      fields: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`field-${index}`, "x".repeat(3_000)]),
      ),
    });
    await trajectoryRecorder.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    ) as { data?: { truncated?: boolean; reason?: string } };
    expect(parsed.data?.truncated).toBe(true);
    expect(parsed.data?.reason).toBe("trajectory-event-size-limit");
  });

  it("keeps compiled context when tool schema descriptors throw", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        model: { api: "responses" },
      } as never,
      env: {},
    });
    let nameReads = 0;
    const unreadableNameTool = {
      inputSchema: { type: "object" },
      get name() {
        throw new Error("tool name getter exploded");
      },
    };
    const unreadableDescriptionTool = {
      name: "descriptionless",
      inputSchema: { type: "object" },
      get description() {
        throw new Error("tool description getter exploded");
      },
    };
    const unreadableSchemaTool = {
      name: "schema",
      description: "bad schema",
      get inputSchema() {
        throw new Error("tool schema getter exploded");
      },
    };
    const singleReadNameTool = {
      description: "single read",
      inputSchema: { type: "object" },
      get name() {
        nameReads += 1;
        if (nameReads > 1) {
          throw new Error("tool name read twice");
        }
        return " single_read ";
      },
    };
    const nestedSchema = { type: "object" };
    Object.defineProperty(nestedSchema, "properties", {
      get() {
        throw new Error("schema field getter exploded");
      },
      enumerable: true,
    });
    const proxySchema = new Proxy(
      { type: "object" },
      {
        ownKeys() {
          throw new Error("schema keys exploded");
        },
      },
    );
    const proxyArray = new Proxy([{ ok: true }], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("schema array item exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    recordCodexTrajectoryContext(trajectoryRecorder, {
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        prompt: "hello",
        model: { api: "responses" },
      },
      developerInstructions: "system",
      tools: [
        unreadableNameTool,
        unreadableDescriptionTool,
        unreadableSchemaTool,
        singleReadNameTool,
        { name: "nested", description: "nested schema", inputSchema: nestedSchema },
        { name: "proxy", inputSchema: proxySchema },
        { name: "array", inputSchema: proxyArray },
        { name: "healthy", inputSchema: { type: "object", properties: { value: {} } } },
      ],
    } as never);
    await trajectoryRecorder.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    );
    expect(parsed.data?.tools).toEqual([
      { name: "array", parameters: ["<unreadable>"] },
      { name: "descriptionless", parameters: { type: "object" } },
      { name: "healthy", parameters: { type: "object", properties: { value: {} } } },
      {
        name: "nested",
        description: "nested schema",
        parameters: { type: "object", properties: "<unreadable>" },
      },
      { name: "proxy", parameters: "<unreadable>" },
      { name: "schema", description: "bad schema", parameters: "<unreadable>" },
      { name: "single_read", description: "single read", parameters: { type: "object" } },
    ]);
    expect(nameReads).toBe(1);
  });
});
