import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_PROFILE_RUNTIME_CONTRACT,
  createAuthAliasManifestRegistry,
  expectedForwardedAuthProfile,
} from "../../test/helpers/agents/auth-profile-runtime-contract.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { runAgentAttempt } from "./command/attempt-execution.js";
import type { EmbeddedPiRunResult } from "./pi-embedded.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<() => PluginManifestRegistry>(() => ({
    plugins: [],
    diagnostics: [],
  })),
);
const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedPiAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry,
  };
});

vi.mock("./cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("./model-selection.js", () => ({
  isCliProvider: (provider: string) => {
    const normalized = provider.trim().toLowerCase();
    return (
      normalized === AUTH_PROFILE_RUNTIME_CONTRACT.claudeCliProvider ||
      normalized === AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider
    );
  },
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("./pi-embedded.js", () => ({
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
}));

function makeCliResult(text: string): EmbeddedPiRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: AUTH_PROFILE_RUNTIME_CONTRACT.sessionId,
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        model: "gpt-5.4",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      executionTrace: {
        winnerProvider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        winnerModel: "gpt-5.4",
        fallbackUsed: false,
        runner: "cli",
      },
    },
  };
}

function makeEmbeddedResult(text: string): EmbeddedPiRunResult {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: AUTH_PROFILE_RUNTIME_CONTRACT.sessionId,
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
        model: "gpt-5.4",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      executionTrace: {
        winnerProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
        winnerModel: "gpt-5.4",
        fallbackUsed: false,
        runner: "embedded",
      },
    },
  };
}

async function runAuthContractAttempt(params: {
  tmpDir: string;
  storePath: string;
  providerOverride: string;
  authProfileProvider: string;
  authProfileOverride: string;
}) {
  const sessionEntry: SessionEntry = {
    sessionId: AUTH_PROFILE_RUNTIME_CONTRACT.sessionId,
    updatedAt: Date.now(),
    authProfileOverride: params.authProfileOverride,
    authProfileOverrideSource: "user",
  };
  const sessionStore: Record<string, SessionEntry> = {
    [AUTH_PROFILE_RUNTIME_CONTRACT.sessionKey]: sessionEntry,
  };
  await fs.writeFile(params.storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

  await runAgentAttempt({
    providerOverride: params.providerOverride,
    modelOverride: "gpt-5.4",
    cfg: {} as OpenClawConfig,
    sessionEntry,
    sessionId: sessionEntry.sessionId,
    sessionKey: AUTH_PROFILE_RUNTIME_CONTRACT.sessionKey,
    sessionAgentId: "main",
    sessionFile: path.join(params.tmpDir, "session.jsonl"),
    workspaceDir: params.tmpDir,
    body: AUTH_PROFILE_RUNTIME_CONTRACT.workspacePrompt,
    isFallbackRetry: false,
    resolvedThinkLevel: "medium",
    timeoutMs: 1_000,
    runId: AUTH_PROFILE_RUNTIME_CONTRACT.runId,
    opts: { senderIsOwner: false } as Parameters<typeof runAgentAttempt>[0]["opts"],
    runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
    spawnedBy: undefined,
    messageChannel: undefined,
    skillsSnapshot: undefined,
    resolvedVerboseLevel: undefined,
    agentDir: params.tmpDir,
    onAgentEvent: vi.fn(),
    authProfileProvider: params.authProfileProvider,
    sessionStore,
    storePath: params.storePath,
    sessionHasHistory: false,
  });
}

describe("Auth profile runtime contract - Pi and CLI adapter", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-contract-"));
    storePath = path.join(tmpDir, "sessions.json");
    loadPluginManifestRegistry.mockReset().mockReturnValue(createAuthAliasManifestRegistry());
    runCliAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockReset();
    runCliAgentMock.mockResolvedValue(makeCliResult("ok"));
    runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedResult("ok"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves codex-cli through the provider auth alias resolver using a mocked manifest", () => {
    expect(resolveProviderIdForAuth(AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider)).toBe(
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
    );
  });

  it("forwards an OpenAI Codex auth profile when the selected provider is codex-cli", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.authProfileId).toBe(
      expectedForwardedAuthProfile({
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
        authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
        sessionAuthProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      }),
    );
  });

  it("does not leak an OpenAI Codex auth profile into an unrelated CLI provider", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.claudeCliProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.authProfileId).toBe(
      expectedForwardedAuthProfile({
        provider: AUTH_PROFILE_RUNTIME_CONTRACT.claudeCliProvider,
        authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
        sessionAuthProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      }),
    );
  });

  it("forwards an OpenAI Codex auth profile through the embedded Pi path", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.authProfileId).toBe(
      AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    );
  });

  it("does not leak an OpenAI Codex auth profile into an unrelated embedded provider", async () => {
    await runAuthContractAttempt({
      tmpDir,
      storePath,
      providerOverride: "openai",
      authProfileProvider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
      authProfileOverride: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.authProfileId).toBeUndefined();
  });
});
