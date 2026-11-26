import type { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";
import { vi } from "vitest";
import { createCopilotAgentHarness } from "../harness.js";
import type { CopilotClientPool } from "./runtime.js";

type IsolatedCompletionParams = Parameters<NonNullable<AgentHarness["runIsolatedCompletionV2"]>>[0];

export function createCopilotIsolatedCompletionParams(
  options: Partial<Pick<IsolatedCompletionParams, "timeoutMs" | "thinkLevel">> = {},
) {
  return {
    provider: "github-copilot",
    modelId: "gpt-4.1",
    authorization: {
      owner: "host",
      model: {
        id: "gpt-4.1",
        name: "GPT-4.1",
        api: "openai-responses",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      auth: {
        apiKey: "prepared-github-token",
        profileId: "github:work",
        source: "profile",
        mode: "oauth",
      },
      sourceAuthFingerprint: "prepared-owner-fingerprint",
    },
    config: {},
    agentId: "test",
    agentDir: "/tmp/agent",
    workspaceDir: "/workspace",
    systemPrompt: "Answer only from the supplied prompt.",
    prompt: "What is two plus two?",
    timeoutMs: 30_000,
    ...options,
  } satisfies IsolatedCompletionParams;
}

export function createCopilotIsolatedHarnessFixture(
  data: Extract<SessionEvent, { type: "assistant.message" }>["data"] = {
    content: "",
    messageId: "message-1",
  },
) {
  const KEY = {
    agentId: "test",
    authMode: "useLoggedInUser" as const,
    copilotHome: "/tmp/copilot",
  };
  const ISOLATED = createCopilotIsolatedCompletionParams({ thinkLevel: "high" });
  const usageListeners = new Set<(event: SessionEvent) => void>();
  const session = {
    on: vi.fn((type: string, listener: (event: SessionEvent) => void) => {
      if (type === "assistant.usage") {
        usageListeners.add(listener);
      }
      return () => usageListeners.delete(listener);
    }),
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    rpc: { remote: { disable: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) } },
    sendAndWait: vi.fn().mockResolvedValue({ type: "assistant.message", data }),
  };
  const createSession = vi.fn().mockResolvedValue(session);
  const resumeSession = vi.fn();
  const handle = { key: KEY, client: { createSession, resumeSession } as unknown as CopilotClient };
  const pool = {
    acquire: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn().mockResolvedValue([]),
    size: vi.fn().mockReturnValue(0),
  } satisfies CopilotClientPool;
  pool.acquire.mockResolvedValue(handle);
  const harness = createCopilotAgentHarness({ pool });
  return {
    session,
    pool,
    handle,
    harness,
    createSession,
    resumeSession,
    emitUsage(
      usageData: Extract<SessionEvent, { type: "assistant.usage" }>["data"],
      agentId?: string,
    ) {
      for (const listener of usageListeners) {
        listener({
          type: "assistant.usage",
          ...(agentId !== undefined ? { agentId } : {}),
          ephemeral: true,
          data: usageData,
          id: "fixture-usage",
          parentId: null,
          timestamp: "2026-01-01T00:00:00Z",
        });
      }
    },
    complete: (extra: Partial<IsolatedCompletionParams> = {}) =>
      harness.runIsolatedCompletionV2?.({ ...ISOLATED, ...extra }),
  };
}
