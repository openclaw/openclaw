import { AsyncLocalStorage } from "node:async_hooks";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import type { CurrentTurnDeliveryAuthority } from "../current-turn-delivery.js";
import type { CronScheduledToolProjectionRequest } from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

export type AgentHarnessScheduledToolProjectionFactory = (
  sourceTool: AnyAgentTool,
  projection: CronScheduledToolProjectionRequest,
) => AnyAgentTool;

export type AgentHarnessTtsProvenanceTransfer = <T extends object>(
  toolResult: unknown,
  attemptResult: T,
  eligibleMediaUrls: readonly string[],
) => T;

export type PreparedQuestionAnswerAuthority = Readonly<{
  sessionKey: string;
  assertActive: () => void;
  assertCaller: (caller: ReplyToolAuthorityOverlay) => void;
}>;

const questionAnswerScope = new AsyncLocalStorage<PreparedQuestionAnswerAuthority | undefined>();
const currentTurnDeliveryScope = new AsyncLocalStorage<CurrentTurnDeliveryAuthority | undefined>();
const questionAnswerCapabilities = new WeakMap<
  AgentHarnessHostCapabilities,
  PreparedQuestionAnswerAuthority
>();

/** Retain the creator's prepared policy; a matching hash alone never grants authority. */
export function createAgentQuestionAnswerAuthority(params: {
  sessionKey: string;
  fingerprint: string | undefined;
  project: (caller: ReplyToolAuthorityOverlay) => string | undefined;
  assertActive: () => void;
}): PreparedQuestionAnswerAuthority {
  return Object.freeze({
    sessionKey: params.sessionKey.trim(),
    assertActive: params.assertActive,
    assertCaller: (caller: ReplyToolAuthorityOverlay) => {
      params.assertActive();
      const projected = params.project(caller);
      params.assertActive();
      if (!params.fingerprint || projected !== params.fingerprint) {
        throw new Error("question answer caller policy does not match its creator");
      }
    },
  });
}

export function withAgentQuestionAnswerAuthority<T>(
  authority: PreparedQuestionAnswerAuthority | undefined,
  run: () => T,
): T {
  return questionAnswerScope.run(authority, run);
}

export function registerAgentHarnessQuestionAnswerAuthority(
  hostCapabilities: AgentHarnessHostCapabilities,
  authority: PreparedQuestionAnswerAuthority,
): void {
  questionAnswerCapabilities.set(hostCapabilities, authority);
}

/** An explicit host carrier cannot fall back to an unrelated ambient creator. */
export function resolveAgentQuestionAnswerAuthority(
  hostCapabilities?: AgentHarnessHostCapabilities,
): PreparedQuestionAnswerAuthority | undefined {
  return hostCapabilities
    ? questionAnswerCapabilities.get(hostCapabilities)
    : questionAnswerScope.getStore();
}

export function captureAgentQuestionAnswerAuthority(
  sessionKey: string,
): PreparedQuestionAnswerAuthority | undefined {
  const authority = questionAnswerScope.getStore();
  authority?.assertActive();
  if (authority && authority.sessionKey !== sessionKey.trim()) {
    throw new Error("question creator authority belongs to another session");
  }
  return authority;
}

/** Makes ordinary delivery available only while the owning host invocation is active. */
export function withAgentHarnessCurrentTurnDeliveryAuthority<T>(
  authority: CurrentTurnDeliveryAuthority,
  run: () => T,
): T {
  return currentTurnDeliveryScope.run(authority, run);
}

/** Captures the exact host scope at construction; later invocations cannot lend authority. */
export function captureAgentHarnessCurrentTurnDeliveryAuthority():
  | CurrentTurnDeliveryAuthority
  | undefined {
  const authority = currentTurnDeliveryScope.getStore();
  authority?.assertActive();
  return authority;
}

type RetainedBeforeToolCallRunner = Readonly<{
  assertActive: () => void;
  release: () => void;
  runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"];
}>;

const retainedBeforeToolCallRunners = new WeakMap<
  AgentHarnessHostCapabilities["runBeforeToolCall"],
  () => RetainedBeforeToolCallRunner | undefined
>();

/** Retain issued policy without importing the capability constructor and its tool graph. */
export function retainBeforeToolCallForNativeHookRelay(
  runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"],
): RetainedBeforeToolCallRunner | undefined {
  return retainedBeforeToolCallRunners.get(runBeforeToolCall)?.();
}

export function registerAgentHarnessBeforeToolCallRetention(
  runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"],
  retain: () => RetainedBeforeToolCallRunner | undefined,
): void {
  retainedBeforeToolCallRunners.set(runBeforeToolCall, retain);
}

const scheduledToolProjectionCapabilities = new WeakMap<
  AgentHarnessHostCapabilities,
  Readonly<{
    ownerPluginId: string;
    create: AgentHarnessScheduledToolProjectionFactory;
  }>
>();
const ttsProvenanceTransferCapabilities = new WeakMap<
  AgentHarnessHostCapabilities,
  Readonly<{ ownerPluginId: string; transfer: AgentHarnessTtsProvenanceTransfer }>
>();
const currentTurnDeliveryTools = new WeakMap<readonly AnyAgentTool[], AnyAgentTool>();

/** Records the exact host-bound delivery tool for one constructed tool surface. */
export function registerAgentHarnessCurrentTurnDeliveryTool(
  tools: readonly AnyAgentTool[],
  tool: AnyAgentTool | undefined,
): void {
  if (tool) {
    currentTurnDeliveryTools.set(tools, tool);
  }
}

/** Resolves only the host-bound delivery instance carried by this exact surface. */
export function resolveAgentHarnessCurrentTurnDeliveryTool(
  tools: readonly AnyAgentTool[],
): AnyAgentTool | undefined {
  return currentTurnDeliveryTools.get(tools);
}

export function registerAgentHarnessScheduledToolProjectionCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
  create: AgentHarnessScheduledToolProjectionFactory;
}): void {
  scheduledToolProjectionCapabilities.set(
    params.hostCapabilities,
    Object.freeze({ ownerPluginId: params.ownerPluginId, create: params.create }),
  );
}

/** Resolves a private issuer only for the exact authoritative plugin owner. */
export function resolveAgentHarnessScheduledToolProjectionCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
}): AgentHarnessScheduledToolProjectionFactory | undefined {
  const capability = scheduledToolProjectionCapabilities.get(params.hostCapabilities);
  return capability?.ownerPluginId === params.ownerPluginId ? capability.create : undefined;
}

export function registerAgentHarnessTtsProvenanceTransferCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
  transfer: AgentHarnessTtsProvenanceTransfer;
}): void {
  ttsProvenanceTransferCapabilities.set(
    params.hostCapabilities,
    Object.freeze({ ownerPluginId: params.ownerPluginId, transfer: params.transfer }),
  );
}

/** Resolves private TTS delivery transfer only for the exact authoritative plugin owner. */
export function resolveAgentHarnessTtsProvenanceTransferCapability(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  ownerPluginId: string;
}): AgentHarnessTtsProvenanceTransfer | undefined {
  const capability = ttsProvenanceTransferCapabilities.get(params.hostCapabilities);
  return capability?.ownerPluginId === params.ownerPluginId ? capability.transfer : undefined;
}
