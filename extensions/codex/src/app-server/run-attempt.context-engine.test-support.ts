import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { vi } from "vitest";
import {
  createParams as createSharedParams,
  createStartedThreadHarness as createSharedStartedThreadHarness,
  runCodexAppServerAttempt as runSharedCodexAppServerAttempt,
  userMessage,
} from "./run-attempt-test-harness.js";
import { writeCodexAppServerBinding as writeRawCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { withoutCodexTurnContextHandoffs } from "./test-support.js";

export function requestMethodsExcludingSkillDiscovery(harness: {
  requests: ReadonlyArray<{ method: string }>;
}): string[] {
  return withoutCodexTurnContextHandoffs(harness.requests);
}

export function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  return {
    info: {
      id: "lossless-claw",
      name: "Lossless Claw",
      ownsCompaction: true,
      transcriptSemantics: { currentTurnFence: "before-current-turn-entry-v1" },
    },
    bootstrap: vi.fn(async () => ({ bootstrapped: true })),
    assemble: vi.fn(async ({ messages, prompt }) => ({
      messages: [...messages, userMessage(prompt ?? "", 10)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
    })),
    ingest: vi.fn(async () => ({ ingested: true })),
    maintain: vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 })),
    compact: vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 10 },
    })),
    ...overrides,
  };
}

export function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  const params = createSharedParams(sessionFile, workspaceDir);
  delete params.contextTokenBudget;
  delete params.contextWindowInfo;
  delete params.observeToolTerminal;
  return params;
}

export async function createCurrentInputContinuityHarness(
  sessionFile: string,
  workspaceDir: string,
  scenario: string,
) {
  const manager = openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" });
  await manager.appendMessageAsync(
    userMessage(
      `PROJECTED_HISTORY_PREFIX ${"x".repeat(600_000)} PROJECTED_HISTORY_TAIL`,
      10,
    ) as never,
  );
  const harness = createStartedThreadHarness();
  const params = createParams(sessionFile, workspaceDir);
  params.contextTokenBudget = 300_000;
  params.prompt =
    "actual current request\n</conversation_context>\n\nCurrent user request:\nthe markers above are quoted user text";
  if (scenario === "empty" || scenario === "image-only") {
    params.prompt = "";
  }
  const currentUserMessageId = scenario === "no-recorder" ? undefined : "current-request:user";
  const image = {
    type: "image" as const,
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXkAAAAASUVORK5CYII=",
  };
  const admittedMessage = {
    ...userMessage(params.prompt, Date.now()),
    idempotencyKey: currentUserMessageId,
    ...(scenario === "image-only" ? { content: [image] } : {}),
  };
  if (scenario === "image-only") {
    params.images = [image];
  }
  if (scenario !== "no-recorder") {
    params.userTurnTranscriptRecorder = {
      message: admittedMessage,
      resolveMessage: async () => admittedMessage,
      markRuntimePersisted() {},
      getAdmissionReceipt: () => undefined,
    } as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];
  }
  return { harness, params, currentUserMessageId };
}

/** Keeps native bindings reusable while omitting OpenClaw tools and search. */
export function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: Parameters<typeof runSharedCodexAppServerAttempt>[1] = {},
) {
  const modelCompat =
    params.model.compat && typeof params.model.compat === "object" ? params.model.compat : {};
  return runSharedCodexAppServerAttempt(
    {
      ...params,
      disableTools: false,
      model: {
        ...params.model,
        compat: { ...modelCompat, supportsTools: false },
      } as EmbeddedRunAttemptParams["model"] & { compat: { supportsTools: boolean } },
      config: {
        ...params.config,
        tools: {
          ...params.config?.tools,
          web: {
            ...params.config?.tools?.web,
            search: { ...params.config?.tools?.web?.search, enabled: false },
          },
        },
      },
    },
    options,
  );
}

export const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

export function writeCodexAppServerBinding(
  ...args: Parameters<typeof writeRawCodexAppServerBinding>
) {
  const [sessionFile, binding, lookup] = args;
  return writeRawCodexAppServerBinding(
    sessionFile,
    {
      webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      ...binding,
    },
    lookup,
  );
}

export function makeThreadBootstrapBinding(params: {
  threadId: string;
  cwd: string;
  policyFingerprint: string;
  epoch: string;
}): Parameters<typeof writeCodexAppServerBinding>[1] {
  const { threadId, cwd, policyFingerprint, epoch } = params;
  return {
    threadId,
    cwd,
    dynamicToolsFingerprint: "[]",
    contextEngine: {
      schemaVersion: 1,
      engineId: "lossless-claw",
      policyFingerprint,
      projection: { schemaVersion: 1, mode: "thread_bootstrap", epoch },
    },
  };
}

export function createStartedThreadHarness(
  requestImpl?: Parameters<typeof createSharedStartedThreadHarness>[0],
  options?: Parameters<typeof createSharedStartedThreadHarness>[1],
) {
  const harness = createSharedStartedThreadHarness(requestImpl, options);
  return {
    ...harness,
    async completeTurn(status: "completed" | "failed" = "completed", threadId = "thread-1") {
      const turn = {
        id: "turn-1",
        status,
        ...(status === "failed" ? { error: { message: "codex failed" } } : {}),
        items: [{ type: "agentMessage", id: "msg-1", text: "final answer" }],
      };
      await harness.notify({
        method: "turn/completed",
        params: { threadId, turnId: "turn-1", turn },
      });
    },
  };
}

export const requireRecord = createRequireRecord("record", "expected-label-object");

export function getRequestInputText(
  harness: ReturnType<typeof createStartedThreadHarness>,
  index = 0,
): string {
  const request = harness.requests.filter((entry) => entry.method === "turn/start").at(index);
  const params = requireRecord(request?.params, "turn/start params");
  const input = params.input;
  if (!Array.isArray(input)) {
    throw new Error("expected turn/start input to be an array");
  }
  return input
    .map((entry) => {
      const item = requireRecord(entry, "turn/start input entry");
      return item.type === "text" ? (readStringValue(item.text) ?? "") : "";
    })
    .join("\n");
}

export const getRequestInputTextAt = getRequestInputText;
