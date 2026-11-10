import { randomUUID } from "node:crypto";
import type {
  AgentHarnessAttemptParamsV2 as AttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { runWithAsyncWorkResources } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import {
  createCopilotAgentHarness as createHarness,
  type CopilotSessionBinding as Binding,
} from "./harness.js";
import { createCopilotTestHostCapabilities as createTestHost } from "./src/host-capability.test-support.js";

type CanonicalAttemptResult = Extract<AgentHarnessAttemptResult, { terminal: unknown }>;

export function makeSessionStoreMock() {
  const entries = new Map<string, Binding>();
  return {
    entries,
    store: {
      register: vi.fn(async (key: string, value: Binding) => void entries.set(key, value)),
      lookup: vi.fn(async (key: string) => entries.get(key)),
      delete: vi.fn(async (key: string) => entries.delete(key)),
    },
  };
}

export function asAttemptParams(value: Record<string, unknown>): AttemptParams {
  return { hostCapabilities: createTestHost(), ...value } as unknown as AttemptParams;
}

export function asCompleteAttemptResult(value: Record<string, unknown>): CanonicalAttemptResult {
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...value,
  } as CanonicalAttemptResult;
}

export function createCopilotAgentHarness(options?: Parameters<typeof createHarness>[0]) {
  const harness = createHarness(options);
  if (typeof harness.compact !== "function") {
    return harness;
  }
  const compact = (params: AgentHarnessCompactParams<2>) => {
    if (typeof harness.compact !== "function") {
      throw new Error("Copilot harness does not support compaction");
    }
    return harness.compact(params);
  };
  return {
    ...harness,
    compact: (
      params: Omit<Parameters<typeof compact>[0], "hostCapabilities"> &
        Partial<Pick<Parameters<typeof compact>[0], "hostCapabilities">>,
    ) => {
      if (params.hostCapabilities) {
        return compact({ ...params, hostCapabilities: params.hostCapabilities });
      }
      return runWithAsyncWorkResources(async (onAcquired) => {
        const host = await createAgentHarnessHostCapabilitiesForTest({
          attempt: {
            runId: params.runId ?? randomUUID(),
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionTarget: params.sessionTarget,
            agentId: params.agentId,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            config: params.config,
            abortSignal: params.abortSignal,
          },
          pluginId: "copilot",
        });
        onAcquired({ release: host.close, releaseBeforeResultWhenIdle: true });
        const { kind, version, assertActive, retainSourceAuthority } = host.capabilities;
        if (!retainSourceAuthority) {
          throw new Error("Compaction fixture requires the production source capability");
        }
        return await compact({
          ...params,
          hostCapabilities: { kind, version, assertActive, retainSourceAuthority },
        });
      });
    },
  };
}

export function asFinalizationAttempt(params: AttemptParams) {
  const { hostCapabilities: _hostCapabilities, ...attempt } = params;
  return attempt;
}
