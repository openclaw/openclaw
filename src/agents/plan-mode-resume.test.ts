import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  getSessionPlanState,
  getSessionRuntimeMode,
  readSessionRuntimeStateFromStorePath,
  saveSessionStore,
  setSessionRuntimeMode,
  updateSessionPlanState,
} from "../config/sessions.js";
import { buildEmbeddedSystemPrompt } from "./pi-embedded-runner/system-prompt.js";

const SESSION_KEY = "agent:main:main";

const buildStatusTextMock = vi.hoisted(() => vi.fn(async () => "OpenClaw\n🧠 Model: GPT-5.4"));

vi.mock("../auto-reply/reply/commands-status.js", () => ({
  buildStatusText: buildStatusTextMock,
}));

let createSessionStatusTool: typeof import("./tools/session-status-tool.js").createSessionStatusTool;

function createTempStorePath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plan-mode-resume-"));
  return {
    root,
    storePath: path.join(root, "sessions.json"),
  };
}

function createTestConfig(storePath: string): OpenClawConfig {
  return {
    session: {
      store: storePath,
      mainKey: "main",
      scope: "per-sender",
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        models: {},
      },
    },
    tools: {
      agentToAgent: { enabled: false },
    },
  } as OpenClawConfig;
}

describe("plan mode persistence and resume", () => {
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    ({ createSessionStatusTool } = await import("./tools/session-status-tool.js"));
  });

  beforeEach(() => {
    buildStatusTextMock.mockClear();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("shows persisted plan mode details in session_status", async () => {
    const { root, storePath } = createTempStorePath();
    tempDirs.add(root);
    const cfg = createTestConfig(storePath);
    await saveSessionStore(storePath, {
      [SESSION_KEY]: {
        sessionId: "session-1",
        updatedAt: 1,
        runtimeMode: "plan",
        planState: {
          content: "1. Read the persisted state\n2. Resume planning",
          todos: [
            {
              id: "resume-context",
              text: "Inject persisted plan into the system prompt",
              status: "in_progress",
            },
            {
              id: "status-output",
              text: "Show plan details in session status",
              status: "pending",
            },
          ],
          enteredAt: 10,
          updatedAt: 11,
        },
      },
    });

    const tool = createSessionStatusTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });
    const result = await tool.execute("call-plan-status", { sessionKey: SESSION_KEY });
    const details = result.details as {
      ok?: boolean;
      planMode?: string;
      planState?: { content?: string; todos?: Array<{ id: string; status: string }> };
      statusText?: string;
    };

    expect(buildStatusTextMock).toHaveBeenCalledTimes(1);
    expect(details.ok).toBe(true);
    expect(details.planMode).toBe("plan");
    expect(details.planState).toMatchObject({
      content: "1. Read the persisted state\n2. Resume planning",
      todos: [
        { id: "resume-context", status: "in_progress" },
        { id: "status-output", status: "pending" },
      ],
    });
    expect(details.statusText).toContain("🗂 Plan Mode: plan");
    expect(details.statusText).toContain("📝 Plan:");
    expect(details.statusText).toContain("1. Read the persisted state");
    expect(details.statusText).toContain(
      "- [in progress] resume-context: Inject persisted plan into the system prompt",
    );
    expect(details.statusText).toContain(
      "- [pending] status-output: Show plan details in session status",
    );
  });

  it("restores persisted plan state from the session store", async () => {
    const { root, storePath } = createTempStorePath();
    tempDirs.add(root);
    const cfg = createTestConfig(storePath);

    await setSessionRuntimeMode(SESSION_KEY, "plan", cfg);
    await updateSessionPlanState({
      sessionKey: SESSION_KEY,
      cfg,
      mutate: () => ({
        content: "1. Persist\n2. Resume",
        todos: [
          {
            id: "persisted-todo",
            text: "Keep the plan state in the session store",
            status: "done",
          },
        ],
        enteredAt: 20,
        updatedAt: 21,
      }),
    });

    expect(getSessionRuntimeMode(SESSION_KEY, cfg)).toBe("plan");
    expect(getSessionPlanState(SESSION_KEY, cfg)).toEqual({
      content: "1. Persist\n2. Resume",
      todos: [
        {
          id: "persisted-todo",
          text: "Keep the plan state in the session store",
          status: "done",
        },
      ],
      enteredAt: 20,
      updatedAt: 21,
    });

    const resumed = readSessionRuntimeStateFromStorePath({
      sessionKey: SESSION_KEY,
      storePath,
    });

    expect(resumed?.runtimeMode).toBe("plan");
    expect(resumed?.planState).toEqual({
      content: "1. Persist\n2. Resume",
      todos: [
        {
          id: "persisted-todo",
          text: "Keep the plan state in the session store",
          status: "done",
        },
      ],
      enteredAt: 20,
      updatedAt: 21,
    });
  });

  it("injects persisted plan guidance into the embedded system prompt", () => {
    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      planModeActive: true,
      planState: {
        content: "1. Summarize the current plan\n2. Wait for confirmation",
        todos: [
          {
            id: "wait-confirmation",
            text: "Do not execute mutation tools before approval",
            status: "in_progress",
          },
        ],
      },
    });

    expect(prompt).toContain("## Plan Mode");
    expect(prompt).toContain("This session is currently in `plan` runtime mode.");
    expect(prompt).toContain("Do not execute mutation tools or side-effecting actions");
    expect(prompt).toContain("Current plan:");
    expect(prompt).toContain("1. Summarize the current plan");
    expect(prompt).toContain(
      "- [in progress] wait-confirmation: Do not execute mutation tools before approval",
    );
    expect(prompt).toContain("exit_plan_mode");
  });
});
