// Codex tests cover conversation control plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCodexAppServerBinding,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.test-helpers.js";
import {
  steerCodexConversationTurn,
  stopCodexConversationTurn,
  trackCodexConversationActiveTurn,
  setCodexConversationFastMode as setCodexConversationFastModeImpl,
  setCodexConversationModel as setCodexConversationModelImpl,
  setCodexConversationPermissions as setCodexConversationPermissionsImpl,
} from "./conversation-control.js";

type LegacyControlParams<T extends (params: never) => unknown> = Omit<
  Parameters<T>[0],
  "identity" | "bindingStore"
> & { sessionFile: string };

function withControlIdentity<T extends { sessionFile: string }>(params: T) {
  const { sessionFile, ...rest } = params;
  return {
    ...rest,
    identity: { kind: "session" as const, agentId: "main", sessionId: sessionFile },
    bindingStore: testCodexAppServerBindingStore,
  };
}

function setCodexConversationFastMode(
  params: LegacyControlParams<typeof setCodexConversationFastModeImpl>,
) {
  return setCodexConversationFastModeImpl(withControlIdentity(params));
}

function setCodexConversationModel(
  params: LegacyControlParams<typeof setCodexConversationModelImpl>,
) {
  return setCodexConversationModelImpl(withControlIdentity(params));
}

function setCodexConversationPermissions(
  params: LegacyControlParams<typeof setCodexConversationPermissionsImpl>,
) {
  return setCodexConversationPermissionsImpl(withControlIdentity(params));
}

let tempDir: string;

function threadResumeResult(
  threadId: string,
  cwd: string,
  model: string,
  modelProvider = "openai",
) {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider,
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd,
      cliVersion: "0.139.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model,
    modelProvider,
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

const sharedClientMocks = vi.hoisted(() => ({
  abandon: vi.fn(async () => undefined),
  getSharedCodexAppServerClient: vi.fn(),
  release: vi.fn(),
}));
const cleanupMocks = vi.hoisted(() => {
  const unsubscribeCodexThreadBestEffort = vi.fn(
    async (_client: unknown, _params: { threadId: string; timeoutMs: number }) => true,
  );
  const settleCodexAppServerClientLease = vi.fn(
    async (
      lease: { client: unknown; release: () => void; abandon: () => Promise<void> },
      params: {
        threadId?: string;
        threadIds?: Iterable<string>;
        timeoutMs: number;
        abandon?: boolean;
      },
    ) => {
      if (params.abandon) {
        await lease.abandon();
        return;
      }
      const threadIds = params.threadIds ?? (params.threadId ? [params.threadId] : []);
      for (const threadId of threadIds) {
        if (
          !(await unsubscribeCodexThreadBestEffort(lease.client, {
            threadId,
            timeoutMs: params.timeoutMs,
          }))
        ) {
          await lease.abandon();
          return;
        }
      }
      lease.release();
    },
  );
  return { settleCodexAppServerClientLease, unsubscribeCodexThreadBestEffort };
});

vi.mock("./app-server/shared-client.js", () => ({
  ...sharedClientMocks,
  leaseSharedCodexAppServerClient: async (...args: unknown[]) => {
    let settled = false;
    return {
      client: await sharedClientMocks.getSharedCodexAppServerClient(...args),
      release: () => {
        if (!settled) {
          settled = true;
          sharedClientMocks.release();
        }
      },
      abandon: async () => {
        if (!settled) {
          settled = true;
          await sharedClientMocks.abandon();
        }
      },
    };
  },
}));
vi.mock("./app-server/attempt-client-cleanup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-server/attempt-client-cleanup.js")>();
  return { ...actual, ...cleanupMocks };
});

describe("codex conversation controls", () => {
  beforeEach(async () => {
    resetCodexTestBindingStore();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-control-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    sharedClientMocks.release.mockClear();
    sharedClientMocks.abandon.mockClear();
    cleanupMocks.unsubscribeCodexThreadBestEffort.mockClear();
    cleanupMocks.settleCodexAppServerClientLease.mockClear();
  });

  it("controls an active turn through its prepared physical client", async () => {
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    const interrupt = vi.fn(async () => undefined);
    const steer = vi.fn(async () => undefined);
    const cleanup = trackCodexConversationActiveTurn({
      identity,
      threadId: "thread-1",
      turnId: "turn-1",
      interrupt,
      steer,
    });
    try {
      await expect(stopCodexConversationTurn({ identity })).resolves.toEqual({
        stopped: true,
        message: "Codex stop requested.",
      });
      await expect(
        steerCodexConversationTurn({ identity, message: "  focus tests  " }),
      ).resolves.toEqual({ steered: true, message: "Sent steer message to Codex." });
      expect(interrupt).toHaveBeenCalledOnce();
      expect(steer).toHaveBeenCalledWith("focus tests");
      expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
    await expect(stopCodexConversationTurn({ identity })).resolves.toEqual({
      stopped: false,
      message: "No active Codex run to stop.",
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearRuntimeAuthProfileStoreSnapshots();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists fast mode and permissions for later bound turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    await expect(setCodexConversationFastMode({ sessionFile, enabled: true })).resolves.toBe(
      "Codex fast mode enabled.",
    );
    await expect(setCodexConversationPermissions({ sessionFile, mode: "default" })).resolves.toBe(
      "Codex permissions set to default.",
    );

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.serviceTier).toBe("priority");
    expect(binding?.approvalPolicy).toBe("on-request");
    expect(binding?.sandbox).toBe("workspace-write");
  });

  it("serializes model resume with concurrent fast-mode updates", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: "flex",
    });
    let resumeStarted!: () => void;
    const resumeStartedPromise = new Promise<void>((resolve) => {
      resumeStarted = resolve;
    });
    let finishResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      finishResume = resolve;
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => {
        resumeStarted();
        await resumeGate;
        return threadResumeResult("thread-1", tempDir, "gpt-5.5");
      }),
    });

    const modelUpdate = setCodexConversationModel({ sessionFile, model: "gpt-5.5" });
    await resumeStartedPromise;
    const fastUpdate = setCodexConversationFastMode({ sessionFile, enabled: true });
    finishResume();

    await expect(modelUpdate).resolves.toBe("Codex model set to gpt-5.5.");
    await expect(fastUpdate).resolves.toBe("Codex fast mode enabled.");
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      model: "gpt-5.5",
      serviceTier: "priority",
    });
  });

  it("does not persist public OpenAI provider after model changes on native auth bindings", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-a", "agent");
    upsertAuthProfile({
      profileId: "work",
      credential: {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "work",
      model: "gpt-5.4",
      modelProvider: "openai",
      nativeContextUsage: { currentTokens: 90_000 },
      modelContextWindow: 258_400,
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => threadResumeResult("thread-1", tempDir, "gpt-5.5")),
    });

    await expect(
      setCodexConversationModel({ sessionFile, agentDir, model: "gpt-5.5" }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    const binding = await readCodexAppServerBinding(sessionFile);
    const sharedClientParams = sharedClientMocks.getSharedCodexAppServerClient.mock.calls[0]?.[0];
    expect(sharedClientParams?.agentDir).toBe(agentDir);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.authProfileId).toBe("work");
    expect(binding?.model).toBe("gpt-5.5");
    expect(binding?.modelProvider).toBeUndefined();
    expect(binding?.nativeContextUsage).toBeUndefined();
    expect(binding?.modelContextWindow).toBeUndefined();
    expect(cleanupMocks.unsubscribeCodexThreadBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: "thread-1" }),
    );
  });

  it("keeps Guardian reviewer when switching a stale local binding to a provider-qualified OpenAI model", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const request = vi.fn(async (_method: string, _requestParams?: unknown) =>
      threadResumeResult("thread-1", tempDir, "gpt-5.5"),
    );
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "openai/gpt-5.5",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    const resumeParams = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(resumeParams?.model).toBe("gpt-5.5");
    expect(resumeParams?.modelProvider).toBe("openai");
    expect(resumeParams?.approvalsReviewer).toBe("auto_review");
    expect(binding?.modelProvider).toBe("openai");
  });

  it("preserves an explicit OpenAI model selector with native auth and trusts the response", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-a", "agent");
    upsertAuthProfile({
      profileId: "work",
      credential: {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "work",
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const request = vi.fn(async (_method: string, _requestParams?: unknown) =>
      threadResumeResult("thread-1", tempDir, "local-model", "lmstudio"),
    );
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      setCodexConversationModel({
        sessionFile,
        agentDir,
        model: "openai/gpt-5.5",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to local-model.");

    const resumeParams = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(resumeParams).toMatchObject({
      model: "gpt-5.5",
      modelProvider: "openai",
      approvalsReviewer: "auto_review",
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("keeps the bound local provider when switching to another unqualified model", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const request = vi.fn(async (_method: string, _requestParams?: unknown) =>
      threadResumeResult("thread-1", tempDir, "local-model-2", "lmstudio"),
    );
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "local-model-2",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to local-model-2.");

    const resumeParams = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(resumeParams?.model).toBe("local-model-2");
    expect(resumeParams?.modelProvider).toBe("lmstudio");
    expect(resumeParams?.approvalsReviewer).toBe("user");
  });

  it("keeps the bound local provider when reselecting a model id with a slash", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "openai/gpt-oss-20b",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const request = vi.fn(async (_method: string, _requestParams?: unknown) =>
      threadResumeResult("thread-1", tempDir, "openai/gpt-oss-20b", "lmstudio"),
    );
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "openai/gpt-oss-20b",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to openai/gpt-oss-20b.");

    const resumeParams = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(resumeParams?.model).toBe("openai/gpt-oss-20b");
    expect(resumeParams?.modelProvider).toBe("lmstudio");
    expect(resumeParams?.approvalsReviewer).toBe("user");
    expect(binding?.modelProvider).toBe("lmstudio");
  });

  it("rejects a control update when resume returns another thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => threadResumeResult("thread-wrong", tempDir, "gpt-5.5")),
    });

    await expect(setCodexConversationModel({ sessionFile, model: "gpt-5.5" })).rejects.toThrow(
      "Codex thread/resume returned thread-wrong for thread-1",
    );
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.4",
    });
    expect(cleanupMocks.unsubscribeCodexThreadBestEffort).not.toHaveBeenCalled();
    expect(sharedClientMocks.abandon).toHaveBeenCalledOnce();
  });

  it("escapes model names returned from Codex before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () =>
        threadResumeResult("thread-1", tempDir, "gpt-5.5 <@U123> [trusted](https://evil)"),
      ),
    });

    await expect(setCodexConversationModel({ sessionFile, model: "gpt-5.5" })).resolves.toBe(
      "Codex model set to gpt-5.5 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09.",
    );
  });
});
