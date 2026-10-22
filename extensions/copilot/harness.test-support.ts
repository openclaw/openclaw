import { randomUUID } from "node:crypto";
import type {
  AgentHarnessAttemptParamsV2 as AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
  AgentHarnessV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { runWithAsyncWorkResources } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import {
  createCopilotAgentHarness as createCopilotAgentHarnessImpl,
  type CopilotSessionBinding,
} from "./harness.js";
import { createCopilotTestHostCapabilities } from "./src/host-capability.test-support.js";

type CanonicalAttemptResult = Extract<AgentHarnessAttemptResult, { terminal: unknown }>;

export function makeSessionStoreMock() {
  const entries = new Map<string, CopilotSessionBinding>();
  return {
    entries,
    store: {
      register: vi.fn(async (key: string, value: CopilotSessionBinding) => {
        entries.set(key, value);
      }),
      lookup: vi.fn(async (key: string) => entries.get(key)),
      delete: vi.fn(async (key: string) => entries.delete(key)),
    },
  };
}

export function asAttemptParams(value: Record<string, unknown>): AgentHarnessAttemptParams {
  return {
    hostCapabilities: createCopilotTestHostCapabilities(),
    ...value,
  } as unknown as AgentHarnessAttemptParams;
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

export function createCopilotAgentHarness(
  options?: Parameters<typeof createCopilotAgentHarnessImpl>[0],
) {
  const harness = createCopilotAgentHarnessImpl(options);
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
      params: AgentHarnessCompactParams &
        Partial<Pick<AgentHarnessCompactParams<2>, "hostCapabilities">>,
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
        const retainSourceAuthority = host.capabilities.retainSourceAuthority;
        if (!retainSourceAuthority) {
          throw new Error("Compaction fixture requires the production source capability");
        }
        const prepared = {
          ...params,
          hostCapabilities: {
            kind: host.capabilities.kind,
            version: host.capabilities.version,
            assertActive: host.capabilities.assertActive,
            retainSourceAuthority,
          },
        };
        return await compact(prepared);
      });
    },
  };
}

type SettledTurnFinalizationAttemptParams = Parameters<
  NonNullable<AgentHarnessV2["finalizeSettledTurn"]>
>[0]["attempt"];

export function asFinalizationAttempt(
  params: AgentHarnessAttemptParams,
): SettledTurnFinalizationAttemptParams {
  const { hostCapabilities: _hostCapabilities, ...attempt } = params;
  return attempt;
}
