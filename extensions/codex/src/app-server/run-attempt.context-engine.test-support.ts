import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
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

export function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  const engine: ContextEngine = {
    info: {
      id: "lossless-claw",
      name: "Lossless Claw",
      ownsCompaction: true,
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1",
      },
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
  return engine;
}

export function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  const params = createSharedParams(sessionFile, workspaceDir);
  delete params.contextTokenBudget;
  delete params.contextWindowInfo;
  delete params.observeToolTerminal;
  return params;
}

/** Keeps native Codex bindings reusable while omitting OpenClaw tools and search. */
function withPersistentCodexTestToolPolicy(
  params: EmbeddedRunAttemptParams,
): EmbeddedRunAttemptParams {
  const modelCompat =
    params.model.compat && typeof params.model.compat === "object" ? params.model.compat : {};
  const model = {
    ...params.model,
    compat: { ...modelCompat, supportsTools: false },
  } as EmbeddedRunAttemptParams["model"] & { compat: { supportsTools: boolean } };
  return {
    ...params,
    disableTools: false,
    model,
    config: {
      ...params.config,
      tools: {
        ...params.config?.tools,
        web: {
          ...params.config?.tools?.web,
          search: {
            ...params.config?.tools?.web?.search,
            enabled: false,
          },
        },
      },
    },
  };
}

export function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: Parameters<typeof runSharedCodexAppServerAttempt>[1] = {},
) {
  return runSharedCodexAppServerAttempt(withPersistentCodexTestToolPolicy(params), options);
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
  return {
    threadId: params.threadId,
    cwd: params.cwd,
    dynamicToolsFingerprint: "[]",
    contextEngine: {
      schemaVersion: 1,
      engineId: "lossless-claw",
      policyFingerprint: params.policyFingerprint,
      projection: {
        schemaVersion: 1,
        mode: "thread_bootstrap",
        epoch: params.epoch,
      },
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
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId,
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status,
            ...(status === "failed" ? { error: { message: "codex failed" } } : {}),
            items: [{ type: "agentMessage", id: "msg-1", text: "final answer" }],
          },
        },
      });
    },
  };
}

export const requireRecord = createRequireRecord("record", "expected-label-object");

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

export function getRequestInputText(
  harness: ReturnType<typeof createStartedThreadHarness>,
): string {
  return getRequestInputTextAt(harness, 0);
}

export function getRequestInputTextAt(
  harness: ReturnType<typeof createStartedThreadHarness>,
  index: number,
): string {
  const request = harness.requests.filter((entry) => entry.method === "turn/start").at(index);
  const params = requireRecord(request?.params, "turn/start params");
  const input = requireArray(params.input, "turn/start input");
  return input
    .map((entry) => {
      const item = requireRecord(entry, "turn/start input entry");
      return item.type === "text" ? (readStringValue(item.text) ?? "") : "";
    })
    .join("\n");
}
