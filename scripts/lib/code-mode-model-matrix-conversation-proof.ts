// Script-local real-model Gateway/channel sidecar for the Code Mode matrix.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import ts from "typescript";
import {
  createQaChannelTransport,
  startQaGatewayChild,
  startQaLabServer,
} from "../../extensions/qa-lab/api.js";
import { resolveAgentEffectiveModelPrimary } from "../../src/agents/agent-scope.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../../src/agents/auth-profiles.js";
import { splitTrailingAuthProfile } from "../../src/agents/model-ref-profile.js";
import { buildConversationIdentity } from "../../src/config/sessions/conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
} from "../../src/config/sessions/conversation-registry.js";
import type { ModelProviderConfig } from "../../src/config/types.models.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  listSessionEntries,
  loadTranscriptEventsSync,
} from "../../src/plugin-sdk/session-store-runtime.js";
import {
  isFrontierCodeModeCapabilityReceipt,
  isFrontierQualificationCandidateModel,
  type FrontierCodeModeCapabilityReceipt,
} from "./code-mode-frontier-model-qualification.js";

export const CODE_MODE_CONVERSATION_PROOF_PROMPT =
  'OpenClaw Code Mode conversation proof. In one deterministic JavaScript or TypeScript exec cell, set requested = { channel: "qa-channel", accountId: "default", kind: "direct", target: "dm:build-bot", threadId: null }. Call conversations_list({ query: requested.target, limit: 100 }) exactly once. Treat the result as complete only when conversations is an array with fewer than 100 rows. Project every row to { conversationRef, channel, accountId, kind, target, threadId }, normalizing a missing threadId to null; labels are display-only and never affect selection. Keep only strict matches across all five requested tuple fields and sort candidates by conversationRef. When resultComplete is true and exactly one candidate remains, send "Build finished." once with that conversationRef unchanged, return { requested, resultComplete, candidates, sendResult } with the raw conversations_send result in sendResult, and make the final answer exactly SENT. Otherwise do not send and return { requested, resultComplete, candidates }. For a complete result with multiple matches, make the final answer AMBIGUOUS_NO_SEND followed by one tab-separated tuple line per sorted candidate. For an incomplete result, make the final answer INCOMPLETE_NO_SEND followed by one tab-separated tuple line per sorted candidate. Use an empty final field for null and no other text. Keep lookup, completeness, projection, strict decision, optional send, and return in that single cell.';

const CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE = {
  channel: "qa-channel",
  accountId: "default",
  kind: "direct",
  target: "dm:build-bot",
  threadId: null,
} as const;

export type CodeModeConversationProofPolicy = {
  api: "openai-responses";
  authMode: "api_key";
  authBindingId: string;
  cachePolicy: {
    build: "shared_immutable";
    os: "uncontrolled";
    provider: "uncontrolled";
  };
  candidateRuntime: "embedded";
  codeModeActivation: "explicit_frozen_run_config";
  codeModeCapability: FrontierCodeModeCapabilityReceipt;
  concurrency: 1;
  credentialEnvName: "OPENAI_API_KEY";
  defaultAgentId: string;
  endpoint: "https://api.openai.com/v1";
  environmentPolicySha256: string;
  fallbacks: "disabled";
  harnessRetries: 0;
  model: string;
  processState: "fresh_per_cell";
  provider: "openai";
  providerRetryPolicy: "openai-responses-runtime-default";
  runtime: "openclaw";
  schedule: "serial_abba";
  seed: "unsupported_unset";
  selectorSource: "config";
  thinking: "high";
};

type PublicCodeModeConversationProofPolicy = Omit<
  CodeModeConversationProofPolicy,
  "defaultAgentId"
> & {
  defaultAgentIdSha256: string;
};

type CodeModeConversationProofParams = {
  buildSha256: string;
  config: OpenClawConfig;
  configSha256: string;
  executionPolicy: CodeModeConversationProofPolicy;
  frozenEnv: NodeJS.ProcessEnv;
  gitSha: string;
  model: string;
  outputDir: string;
  repoRoot: string;
};

function canonicalConversationProofPolicy(
  policy: CodeModeConversationProofPolicy,
): CodeModeConversationProofPolicy {
  return {
    api: policy.api,
    authMode: policy.authMode,
    authBindingId: policy.authBindingId,
    cachePolicy: {
      build: policy.cachePolicy.build,
      os: policy.cachePolicy.os,
      provider: policy.cachePolicy.provider,
    },
    candidateRuntime: policy.candidateRuntime,
    codeModeActivation: policy.codeModeActivation,
    codeModeCapability: policy.codeModeCapability,
    concurrency: policy.concurrency,
    credentialEnvName: policy.credentialEnvName,
    defaultAgentId: policy.defaultAgentId,
    endpoint: policy.endpoint,
    environmentPolicySha256: policy.environmentPolicySha256,
    fallbacks: policy.fallbacks,
    harnessRetries: policy.harnessRetries,
    model: policy.model,
    processState: policy.processState,
    provider: policy.provider,
    providerRetryPolicy: policy.providerRetryPolicy,
    runtime: policy.runtime,
    schedule: policy.schedule,
    seed: policy.seed,
    selectorSource: policy.selectorSource,
    thinking: policy.thinking,
  };
}

function publicConversationProofPolicy(
  policy: CodeModeConversationProofPolicy,
): PublicCodeModeConversationProofPolicy {
  const canonical = canonicalConversationProofPolicy(policy);
  const { defaultAgentId, ...rest } = canonical;
  return {
    ...rest,
    defaultAgentIdSha256: sha256(defaultAgentId),
  };
}

function readConversationProofPolicy(
  value: unknown,
): PublicCodeModeConversationProofPolicy | undefined {
  if (!isRecord(value) || !isRecord(value.cachePolicy)) {
    return undefined;
  }
  if (
    value.api !== "openai-responses" ||
    value.authMode !== "api_key" ||
    typeof value.authBindingId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.authBindingId) ||
    value.cachePolicy.build !== "shared_immutable" ||
    value.cachePolicy.os !== "uncontrolled" ||
    value.cachePolicy.provider !== "uncontrolled" ||
    value.candidateRuntime !== "embedded" ||
    value.codeModeActivation !== "explicit_frozen_run_config" ||
    !isFrontierCodeModeCapabilityReceipt(value.codeModeCapability, value.model as string) ||
    value.concurrency !== 1 ||
    value.credentialEnvName !== "OPENAI_API_KEY" ||
    !isSha256(value.defaultAgentIdSha256) ||
    value.endpoint !== "https://api.openai.com/v1" ||
    !isSha256(value.environmentPolicySha256) ||
    value.fallbacks !== "disabled" ||
    value.harnessRetries !== 0 ||
    typeof value.model !== "string" ||
    !isFrontierQualificationCandidateModel(value.model) ||
    value.processState !== "fresh_per_cell" ||
    value.provider !== "openai" ||
    value.providerRetryPolicy !== "openai-responses-runtime-default" ||
    value.runtime !== "openclaw" ||
    value.schedule !== "serial_abba" ||
    value.seed !== "unsupported_unset" ||
    value.selectorSource !== "config" ||
    value.thinking !== "high"
  ) {
    return undefined;
  }
  const policy = {
    api: value.api,
    authMode: value.authMode,
    authBindingId: value.authBindingId,
    cachePolicy: {
      build: value.cachePolicy.build,
      os: value.cachePolicy.os,
      provider: value.cachePolicy.provider,
    },
    candidateRuntime: value.candidateRuntime,
    codeModeActivation: value.codeModeActivation,
    codeModeCapability: value.codeModeCapability,
    concurrency: value.concurrency,
    credentialEnvName: value.credentialEnvName,
    defaultAgentIdSha256: value.defaultAgentIdSha256,
    endpoint: value.endpoint,
    environmentPolicySha256: value.environmentPolicySha256,
    fallbacks: value.fallbacks,
    harnessRetries: value.harnessRetries,
    model: value.model,
    processState: value.processState,
    provider: value.provider,
    providerRetryPolicy: value.providerRetryPolicy,
    runtime: value.runtime,
    schedule: value.schedule,
    seed: value.seed,
    selectorSource: value.selectorSource,
    thinking: value.thinking,
  } as PublicCodeModeConversationProofPolicy;
  return sameCanonicalValue(value, policy) ? policy : undefined;
}

type ConversationProofIdentity = NonNullable<ReturnType<typeof buildConversationIdentity>>;
type ConversationProofMessage = {
  accountId: string;
  id: string;
  conversation: { id: string; kind: string };
  direction: string;
  text: string;
  threadId?: string;
};
type ConversationProofSnapshot = {
  messages: ConversationProofMessage[];
};
type ConversationProofTranscript = {
  authoredMethods: string[];
  callCount: number | null;
  completedExecResultCount: number;
  attemptedToolNames: string[];
  attemptedToolNamesTruncated: boolean | null;
  execCallCount: number;
  execSource: string;
  finalText: string;
  isError: boolean;
  nestedCalls: ConversationProofNestedCall[];
  sessionId: string;
  value: unknown;
};
type ConversationProofNestedCall = {
  input: unknown;
  name: "conversations_list" | "conversations_send";
  result: unknown;
};
type ConversationProofRuntimeIdentity = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
};
type ConversationProofCell = Record<string, unknown> & {
  id: "Code-exact" | "Code-ambiguous" | "Code-incomplete";
  passed: boolean;
  scenario: "exact" | "ambiguous" | "incomplete";
};
type ValidatedConversationProofCell = ConversationProofCell & {
  agentIdSha256: string;
  elapsedMs: number;
  executedNestedToolCalls: number;
  gatewayConfigSha256: string;
  gatewayPidSha256: string;
  gatewayTempRootSha256: string;
  globalOutboundMessageDelta?: number;
  globalOutboundValid?: boolean;
  outboundMessageDelta: number;
  sessionIdSha256: string;
  sessionKeySha256: string;
};
type ConversationProofSummary = Record<string, unknown> & {
  counts: { failed: number; passed: number; total: number };
  failureCode?: string;
  status: "blocked" | "fail" | "pass";
};

const CONVERSATION_PROOF_CELL_DEFINITIONS = [
  { id: "Code-exact", scenario: "exact" },
  { id: "Code-ambiguous", scenario: "ambiguous" },
  { id: "Code-incomplete", scenario: "incomplete" },
] as const;

function conversationProofSessionKey(agentId: string, id: ConversationProofCell["id"]): string {
  return `agent:${agentId}:code-mode-conversation-${id.toLowerCase()}`;
}

function readConversationProofRuntimeIdentity(
  value: unknown,
): ConversationProofRuntimeIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const agentId = typeof value.agentId === "string" ? value.agentId.trim() : "";
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const sessionKey = typeof value.sessionKey === "string" ? value.sessionKey.trim() : "";
  return agentId && sessionId && sessionKey ? { agentId, sessionId, sessionKey } : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

type ConversationProofTuple = {
  channel: string;
  accountId: string;
  kind: string;
  target: string;
  threadId: string | null;
};

type ConversationProofCandidate = ConversationProofTuple & {
  conversationRef: string;
};

const CONVERSATION_PROOF_TUPLE_KEYS = [
  "accountId",
  "channel",
  "kind",
  "target",
  "threadId",
] as const;
const CONVERSATION_PROOF_CANDIDATE_KEYS = [
  ...CONVERSATION_PROOF_TUPLE_KEYS,
  "conversationRef",
] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (!isRecord(value)) {
    return JSON.stringify(value) ?? "null";
  }
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return sameSequence(actual, expected);
}

function readConversationProofTuple(
  value: unknown,
  options: { exactKeys?: boolean } = {},
): ConversationProofTuple | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (options.exactKeys !== false && !hasExactKeys(value, CONVERSATION_PROOF_TUPLE_KEYS)) {
    return undefined;
  }
  const threadId = value.threadId === null ? null : value.threadId;
  if (
    typeof value.channel !== "string" ||
    typeof value.accountId !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.target !== "string" ||
    (threadId !== null && typeof threadId !== "string")
  ) {
    return undefined;
  }
  return {
    channel: value.channel,
    accountId: value.accountId,
    kind: value.kind,
    target: value.target,
    threadId,
  };
}

function readConversationProofCandidate(
  value: unknown,
  options: { exactKeys?: boolean } = {},
): ConversationProofCandidate | undefined {
  const tuple = readConversationProofTuple(value, { exactKeys: false });
  return isRecord(value) &&
    (options.exactKeys === false || hasExactKeys(value, CONVERSATION_PROOF_CANDIDATE_KEYS)) &&
    typeof value.conversationRef === "string" &&
    /^conv_[a-f0-9]{32}$/u.test(value.conversationRef) &&
    tuple
    ? { conversationRef: value.conversationRef, ...tuple }
    : undefined;
}

function readConversationProofListCandidate(
  value: unknown,
): ConversationProofCandidate | undefined {
  return isRecord(value)
    ? readConversationProofCandidate(
        { ...value, threadId: value.threadId ?? null },
        { exactKeys: false },
      )
    : undefined;
}

function sameCanonicalValue(actual: unknown, expected: unknown): boolean {
  return canonicalJson(actual) === canonicalJson(expected);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function stableFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,63}$/u.test(message) ? message : "conversation_proof_internal_failure";
}

function normalizeTerminalStatus(value: unknown): "completed" | "failed" | "unknown" {
  if (value === "ok" || value === "completed" || value === "succeeded") {
    return "completed";
  }
  if (value === "error" || value === "failed" || value === "cancelled" || value === "timeout") {
    return "failed";
  }
  return "unknown";
}

function readMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return Array.isArray(message.content)
    ? message.content
        .flatMap((block) => (isRecord(block) && typeof block.text === "string" ? [block.text] : []))
        .join("")
    : "";
}

function readToolCallInput(block: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(block.arguments)) {
    return block.arguments;
  }
  if (isRecord(block.input)) {
    return block.input;
  }
  if (typeof block.arguments !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(block.arguments) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readNewOutboundMessages(
  before: ConversationProofSnapshot,
  after: ConversationProofSnapshot,
): ConversationProofMessage[] {
  const priorIds = new Set(before.messages.map((message) => message.id));
  return after.messages.filter(
    (message) => message.direction === "outbound" && !priorIds.has(message.id),
  );
}

function isExpectedExactOutbound(
  message: ConversationProofMessage | undefined,
  candidate: ConversationProofCandidate,
): boolean {
  const targetPrefix =
    message?.conversation.kind === "channel"
      ? "channel"
      : message?.conversation.kind === "group"
        ? "group"
        : "dm";
  return (
    candidate.channel === "qa-channel" &&
    message?.accountId === candidate.accountId &&
    `${targetPrefix}:${message.conversation.id}` === candidate.target &&
    message.conversation.kind === candidate.kind &&
    (message.threadId ?? null) === candidate.threadId &&
    message.text === "Build finished."
  );
}

function readAuthoredMethods(code: string): string[] {
  const source = ts.createSourceFile(
    "conversation-proof.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const authoredMethods: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "tools"
    ) {
      authoredMethods.push(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return authoredMethods;
}

async function readConversationProofTranscript(params: {
  agentId: string;
  gatewayTempRoot: string;
  sessionId: string;
  sessionKey: string;
}): Promise<ConversationProofTranscript> {
  const runtimeEnv = {
    OPENCLAW_STATE_DIR: path.join(params.gatewayTempRoot, "state"),
  };
  const entry = listSessionEntries({ agentId: params.agentId, env: runtimeEnv }).find(
    (candidate) => candidate.sessionKey === params.sessionKey,
  )?.entry;
  if (!entry?.sessionId) {
    throw new Error("conversation_proof_transcript_missing");
  }
  if (entry.sessionId !== params.sessionId) {
    throw new Error("conversation_proof_transcript_identity_mismatch");
  }
  const events = loadTranscriptEventsSync({
    agentId: params.agentId,
    env: runtimeEnv,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  let finalText = "";
  let execCode = "";
  let execToolCallId = "";
  let execResult: Record<string, unknown> | undefined;
  let execCallCount = 0;
  let completedExecResultCount = 0;
  const nestedCallById = new Map<string, Omit<ConversationProofNestedCall, "result">>();
  const nestedCalls: ConversationProofNestedCall[] = [];
  for (const event of events) {
    const message = isRecord(event) && isRecord(event.message) ? event.message : undefined;
    if (!message) {
      continue;
    }
    if (message.role === "assistant") {
      finalText = readMessageText(message) || finalText;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(block) || block.name !== "exec") {
          if (
            isRecord(block) &&
            (block.name === "conversations_list" || block.name === "conversations_send") &&
            typeof block.id === "string"
          ) {
            nestedCallById.set(block.id, {
              name: block.name,
              input: readToolCallInput(block) ?? {},
            });
          }
          continue;
        }
        execCallCount += 1;
        const input = readToolCallInput(block);
        if (execCallCount === 1) {
          execCode = typeof input?.code === "string" ? input.code : "";
          execToolCallId = typeof block.id === "string" ? block.id : "";
        }
      }
    }
    if (message.role === "toolResult" && message.toolName === "exec") {
      completedExecResultCount += 1;
      if (!execResult && (!execToolCallId || message.toolCallId === execToolCallId)) {
        execResult = message;
      }
    }
    if (
      message.role === "toolResult" &&
      (message.toolName === "conversations_list" || message.toolName === "conversations_send") &&
      typeof message.toolCallId === "string"
    ) {
      const pending = nestedCallById.get(message.toolCallId);
      if (pending?.name === message.toolName) {
        const text = readMessageText(message);
        let result: unknown;
        try {
          result = JSON.parse(text);
        } catch {
          result = undefined;
        }
        nestedCalls.push({ ...pending, result });
      }
    }
  }
  if (!execCode || !execResult) {
    throw new Error("conversation_proof_exec_missing");
  }
  const authoredMethods = readAuthoredMethods(execCode);
  const details = isRecord(execResult.details) ? execResult.details : {};
  const telemetry = isRecord(details.telemetry) ? details.telemetry : {};
  const attemptedToolNames = Array.isArray(telemetry.attemptedToolNames)
    ? telemetry.attemptedToolNames.filter((name): name is string => typeof name === "string")
    : [];
  return {
    authoredMethods,
    callCount:
      typeof telemetry.callCount === "number" && Number.isSafeInteger(telemetry.callCount)
        ? telemetry.callCount
        : null,
    completedExecResultCount,
    attemptedToolNames,
    attemptedToolNamesTruncated:
      typeof telemetry.attemptedToolNamesTruncated === "boolean"
        ? telemetry.attemptedToolNamesTruncated
        : null,
    execCallCount,
    execSource: execCode,
    finalText,
    isError: execResult.isError === true,
    nestedCalls,
    sessionId: params.sessionId,
    value: details.value,
  };
}

function sameSequence(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function evaluateConversationProofCell(params: {
  authoredMethods: string[];
  callCount: number | null;
  completedExecResultCount: number;
  elapsedMs: number;
  attemptedToolNames: string[];
  attemptedToolNamesTruncated: boolean | null;
  execCallCount: number;
  execSource: string;
  finalText: string;
  gatewayPidSha256: string;
  isError: boolean;
  nestedCalls: ConversationProofNestedCall[];
  newOutboundMessages: ConversationProofMessage[];
  ordinal: number;
  registeredRows: ConversationProofCandidate[];
  scenario: "exact" | "ambiguous" | "incomplete";
  sessionIdSha256: string;
  terminalErrorPresent: boolean;
  terminalStatus: unknown;
  value: unknown;
}): ConversationProofCell {
  const id = `Code-${params.scenario}` as ConversationProofCell["id"];
  const value = isRecord(params.value) ? params.value : {};
  const rawCandidates = Array.isArray(value.candidates) ? value.candidates : [];
  const parsedCandidates = rawCandidates.map((candidate) =>
    readConversationProofCandidate(candidate),
  );
  const candidatesValid =
    parsedCandidates.every(
      (candidate): candidate is ConversationProofCandidate => candidate !== undefined,
    ) &&
    new Set(parsedCandidates.flatMap((candidate) => (candidate ? [candidate.conversationRef] : [])))
      .size === parsedCandidates.length;
  const candidates = candidatesValid ? parsedCandidates : [];
  const authoredMethods = params.authoredMethods;
  const expectedAuthoredMethods = ["conversations_list", "conversations_send"];
  const exact = params.scenario === "exact";
  const returnedEnvelopeValid = hasExactKeys(
    value,
    exact
      ? ["requested", "resultComplete", "candidates", "sendResult"]
      : ["requested", "resultComplete", "candidates"],
  );
  const expectedAttemptedToolNames = exact
    ? ["conversations_list", "conversations_send"]
    : ["conversations_list"];
  const executionBound =
    sameSequence(authoredMethods, expectedAuthoredMethods) &&
    params.attemptedToolNamesTruncated === false &&
    sameSequence(params.attemptedToolNames, expectedAttemptedToolNames) &&
    params.callCount === expectedAttemptedToolNames.length &&
    params.execCallCount === 1 &&
    params.completedExecResultCount === 1;
  const nestedCallNames = params.nestedCalls.map((call) => call.name);
  const nestedCallsValid =
    sameSequence(nestedCallNames, expectedAttemptedToolNames) &&
    params.nestedCalls.length === expectedAttemptedToolNames.length;
  const listCall = params.nestedCalls[0];
  const sendCall = exact ? params.nestedCalls[1] : undefined;
  const listInputValid =
    listCall?.name === "conversations_list" &&
    sameCanonicalValue(listCall.input, {
      query: CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE.target,
      limit: 100,
    });
  const listedRows =
    listCall?.name === "conversations_list" &&
    isRecord(listCall.result) &&
    Array.isArray(listCall.result.conversations)
      ? listCall.result.conversations
      : undefined;
  const parsedListedRows = listedRows?.map(readConversationProofListCandidate) ?? [];
  const listedRowsValid =
    listedRows !== undefined &&
    parsedListedRows.every(
      (candidate): candidate is ConversationProofCandidate => candidate !== undefined,
    ) &&
    new Set(parsedListedRows.flatMap((candidate) => (candidate ? [candidate.conversationRef] : [])))
      .size === parsedListedRows.length;
  const normalizedListedRows = listedRowsValid ? parsedListedRows : [];
  const resultComplete = listedRows !== undefined && listedRows.length < 100;
  const matchingListedCandidates = normalizedListedRows.filter((candidate) =>
    sameCanonicalValue(
      {
        channel: candidate.channel,
        accountId: candidate.accountId,
        kind: candidate.kind,
        target: candidate.target,
        threadId: candidate.threadId,
      },
      CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE,
    ),
  );
  const sortedMatchingListedCandidates = matchingListedCandidates.toSorted((left, right) =>
    left.conversationRef.localeCompare(right.conversationRef),
  );
  const requestedTuple = readConversationProofTuple(value.requested);
  const requestedTupleValid = sameCanonicalValue(
    requestedTuple,
    CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE,
  );
  const resultCompletenessReported = value.resultComplete === resultComplete;
  const registeredRows = params.registeredRows;
  const expectedListedRows =
    params.scenario === "incomplete" ? registeredRows.slice(0, 100) : registeredRows;
  const expectedCandidates = expectedListedRows
    .filter((candidate) =>
      sameCanonicalValue(
        {
          channel: candidate.channel,
          accountId: candidate.accountId,
          kind: candidate.kind,
          target: candidate.target,
          threadId: candidate.threadId,
        },
        CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE,
      ),
    )
    .toSorted((left, right) => left.conversationRef.localeCompare(right.conversationRef));
  const listedRowSetValid =
    listedRowsValid &&
    sameCanonicalValue(
      normalizedListedRows.toSorted((left, right) =>
        left.conversationRef.localeCompare(right.conversationRef),
      ),
      expectedListedRows.toSorted((left, right) =>
        left.conversationRef.localeCompare(right.conversationRef),
      ),
    );
  const listedCandidateSetValid = sameCanonicalValue(
    sortedMatchingListedCandidates,
    expectedCandidates,
  );
  const candidateSetValid =
    candidatesValid &&
    listedCandidateSetValid &&
    sameCanonicalValue(candidates, expectedCandidates);
  const finalLines = params.finalText.split(/\r?\n/u);
  const finalCandidateLines = finalLines.slice(1);
  const expectedFinalCandidateLines = expectedCandidates
    .map(
      (candidate) =>
        `${candidate.conversationRef}\t${candidate.channel}\t${candidate.accountId}\t${candidate.kind}\t${candidate.target}\t${candidate.threadId ?? ""}`,
    )
    .toSorted();
  const finalReportsExpectedRefs =
    !exact &&
    finalLines[0] ===
      (params.scenario === "ambiguous" ? "AMBIGUOUS_NO_SEND" : "INCOMPLETE_NO_SEND") &&
    sameSequence(finalCandidateLines, expectedFinalCandidateLines);
  const exactFinalValid = !exact || params.finalText === "SENT";
  const outboundMessage = params.newOutboundMessages[0];
  const exactCandidate = expectedCandidates[0];
  const outboundValid = exact
    ? params.newOutboundMessages.length === 1 &&
      exactCandidate !== undefined &&
      isExpectedExactOutbound(outboundMessage, exactCandidate)
    : params.newOutboundMessages.length === 0;
  const sendInputValid =
    !exact ||
    (sendCall?.name === "conversations_send" &&
      sameCanonicalValue(sendCall.input, {
        conversationRef: expectedCandidates[0]?.conversationRef,
        message: "Build finished.",
      }));
  const sendResult = isRecord(value.sendResult) ? value.sendResult : {};
  const rawReceiptMatch =
    !exact ||
    (sendCall?.name === "conversations_send" && sameCanonicalValue(sendResult, sendCall.result));
  const receipt = {
    statusSent: sendResult.status === "sent",
    conversationRefMatch: sendResult.conversationRef === expectedCandidates[0]?.conversationRef,
    channelMatch: sendResult.channel === CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE.channel,
    messageIdPresent: typeof sendResult.messageId === "string" && sendResult.messageId.length > 0,
    messageIdMatch:
      typeof sendResult.messageId === "string" &&
      outboundMessage !== undefined &&
      sendResult.messageId === outboundMessage.id,
  };
  const exactReceiptValid =
    exact &&
    rawReceiptMatch &&
    receipt.statusSent &&
    receipt.conversationRefMatch &&
    receipt.channelMatch &&
    receipt.messageIdPresent &&
    receipt.messageIdMatch;
  const terminalState = normalizeTerminalStatus(params.terminalStatus);
  const terminalValid =
    terminalState === "completed" && !params.terminalErrorPresent && !params.isError;
  const scenarioShapeValid =
    params.scenario === "exact"
      ? resultComplete &&
        registeredRows.length === 6 &&
        listedRows?.length === 6 &&
        expectedCandidates.length === 1
      : params.scenario === "ambiguous"
        ? resultComplete &&
          registeredRows.length === 7 &&
          listedRows?.length === 7 &&
          expectedCandidates.length === 2
        : !resultComplete &&
          listedRows?.length === 100 &&
          params.registeredRows.length === 101 &&
          expectedCandidates.length === 1;
  const exactDecoyCoverage =
    params.scenario !== "exact" ||
    ["channel", "accountId", "kind", "target", "threadId"].every((field) =>
      normalizedListedRows.some((candidate) => {
        const tuple = {
          channel: candidate.channel,
          accountId: candidate.accountId,
          kind: candidate.kind,
          target: candidate.target,
          threadId: candidate.threadId,
        };
        const differences = Object.keys(tuple).filter(
          (key) =>
            tuple[key as keyof ConversationProofTuple] !==
            CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE[key as keyof ConversationProofTuple],
        );
        return differences.length === 1 && differences[0] === field;
      }),
    );
  const failureCode = !terminalValid
    ? "terminal_state_invalid"
    : !returnedEnvelopeValid
      ? "returned_envelope_mismatch"
      : !executionBound
        ? "execution_contract_mismatch"
        : !nestedCallsValid
          ? "nested_call_trace_mismatch"
          : !listInputValid
            ? "list_input_mismatch"
            : !listedRowsValid
              ? "listed_rows_invalid"
              : !listedRowSetValid
                ? "listed_row_set_mismatch"
                : !scenarioShapeValid
                  ? "scenario_shape_mismatch"
                  : !exactDecoyCoverage
                    ? "decoy_coverage_mismatch"
                    : !listedCandidateSetValid
                      ? "listed_candidate_set_mismatch"
                      : !sendInputValid
                        ? "send_input_mismatch"
                        : !outboundValid
                          ? "outbound_delivery_mismatch"
                          : !requestedTupleValid
                            ? "requested_tuple_mismatch"
                            : !resultCompletenessReported
                              ? "list_completeness_unattested"
                              : !candidateSetValid
                                ? "candidate_set_mismatch"
                                : !exact && !finalReportsExpectedRefs
                                  ? "final_order_or_content_mismatch"
                                  : !exactFinalValid
                                    ? "exact_final_mismatch"
                                    : exact && !exactReceiptValid
                                      ? "exact_receipt_mismatch"
                                      : undefined;
  const passed = failureCode === undefined;
  return {
    id,
    scenario: params.scenario,
    mode: "code",
    promptSha256: sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT),
    requestedTupleSha256: sha256(canonicalJson(CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE)),
    expectedAuthoredMethods,
    authoredMethods,
    execSource: params.execSource,
    execSourceSha256: sha256(params.execSource),
    expectedAttemptedToolNames,
    attemptedToolNames: params.attemptedToolNames,
    attemptedToolNamesTruncated: params.attemptedToolNamesTruncated,
    nestedCallNames,
    nestedCalls: params.nestedCalls,
    registeredRows,
    registrySnapshot: {
      rowCount: registeredRows.length,
      sha256: sha256(canonicalJson(registeredRows)),
    },
    listedRows: normalizedListedRows,
    value: params.value,
    finalText: params.finalText,
    outboundMessages: params.newOutboundMessages,
    outerExecCalls: params.execCallCount,
    completedOuterExecResults: params.completedExecResultCount,
    executedNestedToolCalls: params.callCount,
    outboundMessageDelta: params.newOutboundMessages.length,
    gatewayPidSha256: params.gatewayPidSha256,
    sessionIdSha256: params.sessionIdSha256,
    execObserved: params.execCallCount > 0,
    finalSha256: sha256(params.finalText),
    finalReportsExpectedRefs,
    returnedEnvelopeValid,
    resultComplete,
    resultCompletenessReported,
    requestedTupleValid,
    candidateSetValid,
    listedCandidateSetValid,
    candidateSetSha256: sha256(canonicalJson(candidates)),
    expectedCandidateSetSha256: sha256(canonicalJson(expectedCandidates)),
    exactConversationRefSha256:
      expectedCandidates[0] === undefined ? null : sha256(expectedCandidates[0].conversationRef),
    receipt: {
      ...receipt,
      rawReceiptMatch,
      sha256: sha256(
        canonicalJson({
          status: sendResult.status,
          conversationRef: sendResult.conversationRef,
          channel: sendResult.channel,
          messageId: sendResult.messageId,
        }),
      ),
    },
    elapsedMs: params.elapsedMs,
    terminalStatus: terminalState,
    terminalErrorPresent: params.terminalErrorPresent,
    isError: params.isError,
    candidateRefSha256: expectedCandidates
      .map((candidate) => sha256(candidate.conversationRef))
      .toSorted(),
    passed,
    ...(failureCode ? { failureCode } : {}),
    ordinal: params.ordinal,
  };
}

async function runConversationProofCell(params: {
  agentId: string;
  callGateway: (
    method: string,
    request: Record<string, unknown>,
    options: { timeoutMs: number },
  ) => Promise<unknown>;
  gatewayPidSha256: string;
  getSnapshot: () => ConversationProofSnapshot;
  now?: () => number;
  ordinal: number;
  readTranscript: (
    runtimeIdentity: ConversationProofRuntimeIdentity,
  ) => Promise<ConversationProofTranscript>;
  registryRows: ConversationProofCandidate[];
  scenario: "exact" | "ambiguous" | "incomplete";
  thinking: "high";
  uuid?: () => string;
}): Promise<ConversationProofCell> {
  const now = params.now ?? Date.now;
  const uuid = params.uuid ?? randomUUID;
  const id = `Code-${params.scenario}` as ConversationProofCell["id"];
  const beforeBus = params.getSnapshot();
  const sessionKey = conversationProofSessionKey(params.agentId, id);
  const startedAt = now();
  let runtimeIdentity: ConversationProofRuntimeIdentity | undefined;
  try {
    const started = (await params.callGateway(
      "agent",
      {
        idempotencyKey: uuid(),
        agentId: params.agentId,
        sessionKey,
        message: CODE_MODE_CONVERSATION_PROOF_PROMPT,
        deliver: false,
        thinking: params.thinking,
      },
      { timeoutMs: 30_000 },
    )) as { runId?: string };
    if (!started.runId) {
      throw new Error("conversation_proof_run_id_missing");
    }
    const terminal = await params.callGateway(
      "agent.wait",
      { runId: started.runId, timeoutMs: 360_000 },
      { timeoutMs: 365_000 },
    );
    runtimeIdentity = readConversationProofRuntimeIdentity(terminal);
    if (!runtimeIdentity) {
      throw new Error("conversation_proof_runtime_identity_missing");
    }
    const transcript = await params.readTranscript(runtimeIdentity);
    if (transcript.sessionId !== runtimeIdentity.sessionId) {
      throw new Error("conversation_proof_transcript_identity_mismatch");
    }
    if (runtimeIdentity.agentId !== params.agentId || runtimeIdentity.sessionKey !== sessionKey) {
      throw new Error("conversation_proof_runtime_identity_mismatch");
    }
    const afterBus = params.getSnapshot();
    const terminalRecord = isRecord(terminal) ? terminal : {};
    const cell = evaluateConversationProofCell({
      authoredMethods: transcript.authoredMethods,
      callCount: transcript.callCount,
      completedExecResultCount: transcript.completedExecResultCount,
      elapsedMs: now() - startedAt,
      attemptedToolNames: transcript.attemptedToolNames,
      attemptedToolNamesTruncated: transcript.attemptedToolNamesTruncated,
      execCallCount: transcript.execCallCount,
      execSource: transcript.execSource,
      finalText: transcript.finalText,
      gatewayPidSha256: params.gatewayPidSha256,
      isError: transcript.isError,
      nestedCalls: transcript.nestedCalls,
      newOutboundMessages: readNewOutboundMessages(beforeBus, afterBus),
      ordinal: params.ordinal,
      registeredRows: params.registryRows,
      scenario: params.scenario,
      sessionIdSha256: sha256(transcript.sessionId),
      terminalErrorPresent: terminalRecord.error !== undefined,
      terminalStatus: terminalRecord.status,
      value: transcript.value,
    });
    return {
      ...cell,
      agentIdSha256: sha256(runtimeIdentity.agentId),
      sessionKeySha256: sha256(runtimeIdentity.sessionKey),
    };
  } catch (error) {
    return {
      id,
      scenario: params.scenario,
      mode: "code",
      promptSha256: sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT),
      gatewayPidSha256: params.gatewayPidSha256,
      execObserved: false,
      elapsedMs: now() - startedAt,
      ...(runtimeIdentity
        ? {
            agentIdSha256: sha256(runtimeIdentity.agentId),
            sessionIdSha256: sha256(runtimeIdentity.sessionId),
            sessionKeySha256: sha256(runtimeIdentity.sessionKey),
          }
        : {}),
      failureCode: stableFailureCode(error),
      passed: false,
      ordinal: params.ordinal,
    };
  }
}

async function runConversationProofCells(params: {
  runScenario: (
    definition: (typeof CONVERSATION_PROOF_CELL_DEFINITIONS)[number],
    ordinal: number,
  ) => Promise<ConversationProofCell>;
}): Promise<ConversationProofCell[]> {
  const cells: ConversationProofCell[] = [];
  for (const [index, definition] of CONVERSATION_PROOF_CELL_DEFINITIONS.entries()) {
    const cell = await params.runScenario(definition, index + 1);
    cells.push(cell);
  }
  if (cells.length === CONVERSATION_PROOF_CELL_DEFINITIONS.length) {
    const globalOutboundMessageDelta = cells.reduce(
      (total, cell) => total + Number(cell.outboundMessageDelta ?? 0),
      0,
    );
    const globalOutboundValid = globalOutboundMessageDelta === 1;
    const lastCell = cells.at(-1)!;
    cells[cells.length - 1] = {
      ...lastCell,
      globalOutboundMessageDelta,
      globalOutboundValid,
      passed: lastCell.passed && globalOutboundValid,
      ...(globalOutboundValid || lastCell.failureCode
        ? {}
        : { failureCode: "proof_global_outbound_mismatch" }),
    };
  }
  return cells;
}

function validateConversationProofCellRecord(
  value: unknown,
  expected: {
    agentId: string;
    id: ConversationProofCell["id"];
    ordinal: number;
    scenario: ConversationProofCell["scenario"];
  },
): { cell?: ValidatedConversationProofCell; failureCode?: string } {
  if (!isRecord(value)) {
    return { failureCode: "conversation_proof_cell_invalid" };
  }
  const registeredRows = Array.isArray(value.registeredRows)
    ? value.registeredRows.map((candidate) => readConversationProofCandidate(candidate))
    : [];
  if (
    registeredRows.length === 0 ||
    registeredRows.some((candidate) => candidate === undefined) ||
    typeof value.execSource !== "string" ||
    !value.execSource ||
    value.execSourceSha256 !== sha256(value.execSource) ||
    !Array.isArray(value.authoredMethods) ||
    !value.authoredMethods.every((entry) => typeof entry === "string") ||
    !sameSequence(readAuthoredMethods(value.execSource), value.authoredMethods) ||
    !Array.isArray(value.attemptedToolNames) ||
    !value.attemptedToolNames.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.nestedCalls) ||
    !value.nestedCalls.every(
      (entry) =>
        isRecord(entry) &&
        (entry.name === "conversations_list" || entry.name === "conversations_send") &&
        "input" in entry &&
        "result" in entry,
    ) ||
    !Array.isArray(value.outboundMessages) ||
    !isRecord(value.registrySnapshot) ||
    value.registrySnapshot.rowCount !== registeredRows.length ||
    value.registrySnapshot.sha256 !== sha256(canonicalJson(registeredRows)) ||
    value.agentIdSha256 !== sha256(expected.agentId) ||
    typeof value.finalText !== "string" ||
    typeof value.gatewayPidSha256 !== "string" ||
    typeof value.gatewayTempRootSha256 !== "string" ||
    typeof value.sessionIdSha256 !== "string" ||
    value.sessionKeySha256 !== sha256(conversationProofSessionKey(expected.agentId, expected.id)) ||
    typeof value.gatewayConfigSha256 !== "string" ||
    typeof value.elapsedMs !== "number" ||
    typeof value.outerExecCalls !== "number" ||
    typeof value.completedOuterExecResults !== "number" ||
    typeof value.executedNestedToolCalls !== "number" ||
    typeof value.attemptedToolNamesTruncated !== "boolean" ||
    typeof value.terminalErrorPresent !== "boolean" ||
    typeof value.isError !== "boolean" ||
    !isRecord(value.bindings) ||
    value.bindings.routeMatch !== true ||
    value.bindings.profileMatch !== true ||
    value.bindings.credentialBindingMatch !== true ||
    !isRecord(value.cleanup) ||
    value.cleanup.status !== "completed"
  ) {
    return { failureCode: "conversation_proof_cell_invalid" };
  }
  const recomputed = evaluateConversationProofCell({
    authoredMethods: value.authoredMethods as string[],
    callCount: value.executedNestedToolCalls,
    completedExecResultCount: value.completedOuterExecResults,
    elapsedMs: value.elapsedMs,
    attemptedToolNames: value.attemptedToolNames as string[],
    attemptedToolNamesTruncated: value.attemptedToolNamesTruncated,
    execCallCount: value.outerExecCalls,
    execSource: value.execSource,
    finalText: value.finalText,
    gatewayPidSha256: value.gatewayPidSha256,
    isError: value.isError,
    nestedCalls: value.nestedCalls as ConversationProofNestedCall[],
    newOutboundMessages: value.outboundMessages as ConversationProofMessage[],
    ordinal: expected.ordinal,
    registeredRows: registeredRows as ConversationProofCandidate[],
    scenario: expected.scenario,
    sessionIdSha256: value.sessionIdSha256,
    terminalErrorPresent: value.terminalErrorPresent,
    terminalStatus: value.terminalStatus,
    value: value.value,
  });
  const recomputedWithBindings: Record<string, unknown> = {
    ...recomputed,
    agentIdSha256: sha256(expected.agentId),
    sessionKeySha256: sha256(conversationProofSessionKey(expected.agentId, expected.id)),
  };
  const comparableKeys = [
    "id",
    "scenario",
    "ordinal",
    "passed",
    "failureCode",
    "resultComplete",
    "resultCompletenessReported",
    "requestedTupleValid",
    "candidateSetValid",
    "listedCandidateSetValid",
    "finalReportsExpectedRefs",
    "returnedEnvelopeValid",
    "outboundMessageDelta",
    "executedNestedToolCalls",
    "finalSha256",
    "execSourceSha256",
    "candidateSetSha256",
    "expectedCandidateSetSha256",
    "agentIdSha256",
    "sessionIdSha256",
    "sessionKeySha256",
    "gatewayPidSha256",
    "registrySnapshot",
  ] as const;
  const matchesRecomputed = comparableKeys.every((key) =>
    sameCanonicalValue(value[key], recomputedWithBindings[key]),
  );
  if (
    value.id !== expected.id ||
    value.scenario !== expected.scenario ||
    value.ordinal !== expected.ordinal ||
    !matchesRecomputed
  ) {
    return { failureCode: "conversation_proof_cell_attestation_mismatch" };
  }
  return { cell: { ...value, ...recomputed } as ValidatedConversationProofCell };
}

function validateRawCodeModeConversationProofSummary(
  summary: unknown,
  expected?: {
    buildSha256?: string;
    configSha256?: string;
    executionPolicy?: CodeModeConversationProofPolicy;
    gitSha?: string;
    model?: string;
  },
): { failureCode?: string; valid: boolean } {
  if (!isRecord(summary)) {
    return { valid: false, failureCode: "conversation_proof_summary_invalid" };
  }
  const executionPolicy = readConversationProofPolicy(summary.executionPolicy);
  const expectedExecutionPolicy = expected?.executionPolicy;
  const expectedPublicPolicy = expectedExecutionPolicy
    ? publicConversationProofPolicy(expectedExecutionPolicy)
    : undefined;
  const expectedCells = expectedExecutionPolicy
    ? ([
        {
          agentId: expectedExecutionPolicy.defaultAgentId,
          id: "Code-exact",
          scenario: "exact",
          ordinal: 1,
        },
        {
          agentId: expectedExecutionPolicy.defaultAgentId,
          id: "Code-ambiguous",
          scenario: "ambiguous",
          ordinal: 2,
        },
        {
          agentId: expectedExecutionPolicy.defaultAgentId,
          id: "Code-incomplete",
          scenario: "incomplete",
          ordinal: 3,
        },
      ] as const)
    : [];
  if (
    summary.schemaVersion !== 3 ||
    summary.evidenceClass !== "frontier_beta_qualification" ||
    summary.betaGateRole !== "required_separate_behavior_gate_excluded_from_abba_totals" ||
    summary.requestAudit !== "behavior_only_provider_request_unattested" ||
    summary.provider !== "openai" ||
    summary.runtime !== "openclaw" ||
    summary.api !== "openai-responses" ||
    summary.endpoint !== "https://api.openai.com/v1" ||
    summary.thinking !== "high" ||
    summary.credentialEnvName !== "OPENAI_API_KEY" ||
    !isSha256(summary.defaultAgentIdSha256) ||
    typeof summary.model !== "string" ||
    !isFrontierQualificationCandidateModel(summary.model) ||
    !isSha256(summary.authProfileIdSha256) ||
    !executionPolicy ||
    !expectedPublicPolicy ||
    summary.api !== executionPolicy.api ||
    summary.credentialEnvName !== executionPolicy.credentialEnvName ||
    summary.defaultAgentIdSha256 !== executionPolicy.defaultAgentIdSha256 ||
    summary.defaultAgentIdSha256 !== expectedPublicPolicy.defaultAgentIdSha256 ||
    summary.endpoint !== executionPolicy.endpoint ||
    summary.model !== executionPolicy.model ||
    summary.provider !== executionPolicy.provider ||
    summary.runtime !== executionPolicy.runtime ||
    summary.thinking !== executionPolicy.thinking ||
    !isSha256(summary.buildSha256) ||
    !isSha256(summary.configSha256) ||
    !isSha256(summary.executionPolicySha256) ||
    !isSha256(summary.gatewayConfigSha256) ||
    summary.promptSha256 !== sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT) ||
    summary.requestedTupleSha256 !==
      sha256(canonicalJson(CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE)) ||
    summary.executionPolicySha256 !== sha256(canonicalJson(executionPolicy)) ||
    (expected?.buildSha256 !== undefined && summary.buildSha256 !== expected.buildSha256) ||
    (expected?.configSha256 !== undefined && summary.configSha256 !== expected.configSha256) ||
    (expected?.model !== undefined && summary.model !== expected.model) ||
    (expected?.executionPolicy !== undefined &&
      summary.executionPolicySha256 !==
        sha256(canonicalJson(publicConversationProofPolicy(expected.executionPolicy)))) ||
    (expected?.gitSha !== undefined && summary.gitSha !== expected.gitSha) ||
    summary.sourceDirty !== false ||
    summary.routeMatch !== true ||
    summary.profileMatch !== true ||
    summary.credentialBindingMatch !== true ||
    summary.distinctGatewayPids !== true ||
    summary.distinctGatewayTempRoots !== true ||
    !Array.isArray(summary.gatewayPidSha256s) ||
    summary.gatewayPidSha256s.length !== 3 ||
    !summary.gatewayPidSha256s.every(isSha256) ||
    !Array.isArray(summary.gatewayTempRootSha256s) ||
    summary.gatewayTempRootSha256s.length !== 3 ||
    !summary.gatewayTempRootSha256s.every(isSha256) ||
    !Array.isArray(summary.sessionIdHashes) ||
    summary.sessionIdHashes.length !== 3 ||
    !summary.sessionIdHashes.every(isSha256) ||
    !Array.isArray(summary.sessionKeySha256s) ||
    summary.sessionKeySha256s.length !== 3 ||
    !summary.sessionKeySha256s.every(isSha256) ||
    !summary.distinctSessionKeys ||
    !isRecord(summary.cleanup) ||
    summary.cleanup.status !== "completed" ||
    !Array.isArray(summary.cells) ||
    summary.cells.length !== expectedCells.length
  ) {
    return { valid: false, failureCode: "conversation_proof_binding_mismatch" };
  }
  const validatedCells = summary.cells.map((cell, index) =>
    validateConversationProofCellRecord(cell, expectedCells[index]!),
  );
  const cellFailure = validatedCells.find((result) => !result.cell);
  if (cellFailure) {
    return {
      valid: false,
      failureCode: cellFailure.failureCode ?? "conversation_proof_cell_invalid",
    };
  }
  const cells = validatedCells.map((result) => result.cell!);
  const sessionHashes = cells.map((cell) => cell.sessionIdSha256);
  const sessionKeyHashes = cells.map((cell) => cell.sessionKeySha256);
  const gatewayPidHashes = cells.map((cell) => cell.gatewayPidSha256);
  const gatewayTempRootHashes = cells.map((cell) => cell.gatewayTempRootSha256);
  const gatewayConfigHashes = cells.map((cell) => cell.gatewayConfigSha256);
  const globalOutboundTotal = cells.reduce((total, cell) => total + cell.outboundMessageDelta, 0);
  const nestedCallTotals = cells.map((cell) => cell.executedNestedToolCalls);
  if (
    cells.some((cell) => !cell.passed) ||
    !sameSequence(nestedCallTotals.map(String), ["2", "1", "1"]) ||
    globalOutboundTotal !== 1 ||
    new Set(sessionHashes).size !== 3 ||
    new Set(sessionKeyHashes).size !== 3 ||
    new Set(gatewayPidHashes).size !== 3 ||
    new Set(gatewayTempRootHashes).size !== 3 ||
    gatewayConfigHashes.some((hash) => hash !== summary.gatewayConfigSha256) ||
    !sameCanonicalValue(
      gatewayPidHashes.toSorted((left, right) => left.localeCompare(right)),
      (summary.gatewayPidSha256s as string[]).toSorted((left, right) => left.localeCompare(right)),
    ) ||
    !sameCanonicalValue(
      gatewayTempRootHashes.toSorted((left, right) => left.localeCompare(right)),
      (summary.gatewayTempRootSha256s as string[]).toSorted((left, right) =>
        left.localeCompare(right),
      ),
    ) ||
    !sameCanonicalValue(
      sessionHashes.toSorted((left, right) => left.localeCompare(right)),
      summary.sessionIdHashes.toSorted((left, right) => left.localeCompare(right)),
    ) ||
    !sameCanonicalValue(
      sessionKeyHashes.toSorted((left, right) => left.localeCompare(right)),
      summary.sessionKeySha256s.toSorted((left, right) => left.localeCompare(right)),
    ) ||
    cells[2]?.globalOutboundMessageDelta !== 1 ||
    cells[2]?.globalOutboundValid !== true ||
    summary.distinctSessionIds !== true ||
    summary.distinctSessionKeys !== true ||
    !isRecord(summary.counts) ||
    summary.counts.total !== 3 ||
    summary.counts.passed !== 3 ||
    summary.counts.failed !== 0 ||
    summary.status !== "pass"
  ) {
    return { valid: false, failureCode: "conversation_proof_global_invariant_mismatch" };
  }
  return { valid: true };
}

const PUBLIC_CONVERSATION_PROOF_CELL_KEYS = [
  "agentIdSha256",
  "attemptedToolNamesSha256",
  "attemptedToolNamesTruncated",
  "authoredMethodsSha256",
  "bindings",
  "candidateRefSha256",
  "candidateSetSha256",
  "candidateSetValid",
  "cleanup",
  "completedOuterExecResults",
  "elapsedMs",
  "execObserved",
  "execSourceSha256",
  "executedNestedToolCalls",
  "expectedAttemptedToolNamesSha256",
  "expectedAuthoredMethodsSha256",
  "expectedCandidateSetSha256",
  "exactConversationRefSha256",
  "finalReportsExpectedRefs",
  "finalSha256",
  "gatewayConfigSha256",
  "gatewayPidSha256",
  "gatewayTempRootSha256",
  "id",
  "isError",
  "listedCandidateSetValid",
  "listedRowsSnapshot",
  "mode",
  "nestedCallNamesSha256",
  "nestedCallTraceSha256",
  "ordinal",
  "outerExecCalls",
  "outboundMessageDelta",
  "outboundMessagesSha256",
  "passed",
  "promptSha256",
  "rawEvidenceSha256",
  "receipt",
  "registrySnapshot",
  "requestedTupleSha256",
  "requestedTupleValid",
  "resultComplete",
  "resultCompletenessReported",
  "returnedEnvelopeValid",
  "returnedValueSha256",
  "scenario",
  "sendResultSha256",
  "sessionIdSha256",
  "sessionKeySha256",
  "terminalErrorPresent",
  "terminalStatus",
] as const;

const PUBLIC_CONVERSATION_PROOF_SUMMARY_KEYS = [
  "api",
  "authProfileIdSha256",
  "behaviorGateValidated",
  "betaGateRole",
  "buildSha256",
  "cells",
  "cleanup",
  "configSha256",
  "counts",
  "credentialBindingMatch",
  "credentialEnvName",
  "defaultAgentIdSha256",
  "distinctGatewayPids",
  "distinctGatewayTempRoots",
  "distinctSessionIds",
  "distinctSessionKeys",
  "endpoint",
  "evidenceClass",
  "executionPolicy",
  "executionPolicySha256",
  "gatewayConfigSha256",
  "gatewayPidSha256s",
  "gatewayTempRootSha256s",
  "generatedAt",
  "gitSha",
  "model",
  "profileMatch",
  "promptSha256",
  "provider",
  "qualification",
  "requestAudit",
  "requestedTupleSha256",
  "routeMatch",
  "runtime",
  "schemaVersion",
  "sessionIdHashes",
  "sessionKeySha256s",
  "sourceDirty",
  "status",
  "thinking",
] as const;

function projectConversationProofCell(value: unknown): Record<string, unknown> {
  const cell = isRecord(value) ? value : {};
  const returnedValue = isRecord(cell.value) ? cell.value : {};
  const registeredRows = Array.isArray(cell.registeredRows) ? cell.registeredRows : [];
  const listedRows = Array.isArray(cell.listedRows) ? cell.listedRows : [];
  const rawEvidence = {
    execSource: cell.execSource,
    finalText: cell.finalText,
    listedRows: cell.listedRows,
    nestedCalls: cell.nestedCalls,
    outboundMessages: cell.outboundMessages,
    registeredRows: cell.registeredRows,
    value: cell.value,
  };
  return {
    id: cell.id ?? null,
    scenario: cell.scenario ?? null,
    ordinal: cell.ordinal ?? null,
    mode: cell.mode ?? null,
    passed: cell.passed ?? false,
    promptSha256: cell.promptSha256 ?? null,
    requestedTupleSha256: cell.requestedTupleSha256 ?? null,
    expectedAuthoredMethodsSha256: canonicalSha256(cell.expectedAuthoredMethods),
    authoredMethodsSha256: canonicalSha256(cell.authoredMethods),
    execSourceSha256: cell.execSourceSha256 ?? canonicalSha256(cell.execSource),
    expectedAttemptedToolNamesSha256: canonicalSha256(cell.expectedAttemptedToolNames),
    attemptedToolNamesSha256: canonicalSha256(cell.attemptedToolNames),
    attemptedToolNamesTruncated: cell.attemptedToolNamesTruncated ?? null,
    nestedCallNamesSha256: canonicalSha256(cell.nestedCallNames),
    nestedCallTraceSha256: canonicalSha256(cell.nestedCalls),
    registrySnapshot: cell.registrySnapshot ?? {
      rowCount: registeredRows.length,
      sha256: canonicalSha256(registeredRows),
    },
    listedRowsSnapshot: {
      rowCount: listedRows.length,
      sha256: canonicalSha256(listedRows),
    },
    returnedValueSha256: canonicalSha256(cell.value),
    outboundMessagesSha256: canonicalSha256(cell.outboundMessages),
    sendResultSha256:
      "sendResult" in returnedValue ? canonicalSha256(returnedValue.sendResult) : null,
    rawEvidenceSha256: canonicalSha256(rawEvidence),
    outerExecCalls: cell.outerExecCalls ?? null,
    completedOuterExecResults: cell.completedOuterExecResults ?? null,
    executedNestedToolCalls: cell.executedNestedToolCalls ?? null,
    outboundMessageDelta: cell.outboundMessageDelta ?? null,
    gatewayPidSha256: cell.gatewayPidSha256 ?? null,
    sessionIdSha256: cell.sessionIdSha256 ?? null,
    agentIdSha256: cell.agentIdSha256 ?? null,
    sessionKeySha256: cell.sessionKeySha256 ?? null,
    gatewayConfigSha256: cell.gatewayConfigSha256 ?? null,
    gatewayTempRootSha256: cell.gatewayTempRootSha256 ?? null,
    execObserved: cell.execObserved ?? false,
    finalSha256: cell.finalSha256 ?? canonicalSha256(cell.finalText),
    finalReportsExpectedRefs: cell.finalReportsExpectedRefs ?? false,
    returnedEnvelopeValid: cell.returnedEnvelopeValid ?? false,
    resultComplete: cell.resultComplete ?? null,
    resultCompletenessReported: cell.resultCompletenessReported ?? false,
    requestedTupleValid: cell.requestedTupleValid ?? false,
    candidateSetValid: cell.candidateSetValid ?? false,
    listedCandidateSetValid: cell.listedCandidateSetValid ?? false,
    candidateSetSha256: cell.candidateSetSha256 ?? canonicalSha256([]),
    expectedCandidateSetSha256: cell.expectedCandidateSetSha256 ?? canonicalSha256([]),
    exactConversationRefSha256: cell.exactConversationRefSha256 ?? null,
    receipt: cell.receipt ?? null,
    elapsedMs: cell.elapsedMs ?? null,
    terminalStatus: cell.terminalStatus ?? null,
    terminalErrorPresent: cell.terminalErrorPresent ?? null,
    isError: cell.isError ?? null,
    candidateRefSha256: cell.candidateRefSha256 ?? [],
    bindings: cell.bindings ?? null,
    cleanup: cell.cleanup ?? null,
    ...(typeof cell.failureCode === "string" ? { failureCode: cell.failureCode } : {}),
    ...(cell.scenario === "incomplete"
      ? {
          globalOutboundMessageDelta: cell.globalOutboundMessageDelta ?? null,
          globalOutboundValid: cell.globalOutboundValid ?? false,
        }
      : {}),
  };
}

function projectConversationProofSummary(
  summary: ConversationProofSummary,
): ConversationProofSummary {
  return {
    schemaVersion: 4,
    generatedAt: summary.generatedAt,
    model: summary.model,
    provider: summary.provider,
    runtime: summary.runtime,
    api: summary.api,
    endpoint: summary.endpoint,
    thinking: summary.thinking,
    defaultAgentIdSha256: summary.defaultAgentIdSha256,
    credentialEnvName: summary.credentialEnvName,
    authProfileIdSha256: summary.authProfileIdSha256,
    gitSha: summary.gitSha,
    sourceDirty: summary.sourceDirty,
    buildSha256: summary.buildSha256,
    configSha256: summary.configSha256,
    executionPolicySha256: summary.executionPolicySha256,
    executionPolicy: summary.executionPolicy,
    promptSha256: summary.promptSha256,
    requestedTupleSha256: summary.requestedTupleSha256,
    evidenceClass: summary.evidenceClass,
    requestAudit: summary.requestAudit,
    betaGateRole: summary.betaGateRole,
    status: summary.status,
    gatewayConfigSha256: summary.gatewayConfigSha256,
    gatewayPidSha256s: summary.gatewayPidSha256s,
    distinctGatewayPids: summary.distinctGatewayPids,
    gatewayTempRootSha256s: summary.gatewayTempRootSha256s,
    distinctGatewayTempRoots: summary.distinctGatewayTempRoots,
    routeMatch: summary.routeMatch,
    profileMatch: summary.profileMatch,
    credentialBindingMatch: summary.credentialBindingMatch,
    sessionIdHashes: summary.sessionIdHashes,
    distinctSessionIds: summary.distinctSessionIds,
    sessionKeySha256s: summary.sessionKeySha256s,
    distinctSessionKeys: summary.distinctSessionKeys,
    cleanup: summary.cleanup,
    cells: Array.isArray(summary.cells) ? summary.cells.map(projectConversationProofCell) : [],
    counts: summary.counts,
    behaviorGateValidated: summary.behaviorGateValidated,
    qualification: summary.qualification,
    ...(typeof summary.failureCode === "string" ? { failureCode: summary.failureCode } : {}),
  };
}

function isPublicConversationProofSnapshot(value: unknown, expectedRowCount: number): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["rowCount", "sha256"]) &&
    value.rowCount === expectedRowCount &&
    isSha256(value.sha256)
  );
}

function isPublicConversationProofReceipt(value: unknown, exact: boolean): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "channelMatch",
      "conversationRefMatch",
      "messageIdMatch",
      "messageIdPresent",
      "rawReceiptMatch",
      "sha256",
      "statusSent",
    ]) ||
    !isSha256(value.sha256)
  ) {
    return false;
  }
  return exact
    ? value.channelMatch === true &&
        value.conversationRefMatch === true &&
        value.messageIdMatch === true &&
        value.messageIdPresent === true &&
        value.rawReceiptMatch === true &&
        value.statusSent === true
    : value.channelMatch === false &&
        value.conversationRefMatch === false &&
        value.messageIdMatch === false &&
        value.messageIdPresent === false &&
        value.rawReceiptMatch === true &&
        value.statusSent === false;
}

function validatePublicConversationProofCell(
  value: unknown,
  expected: {
    candidateCount: number;
    id: ConversationProofCell["id"];
    listedRowCount: number;
    nestedCallCount: number;
    ordinal: number;
    outboundMessageDelta: number;
    registeredRowCount: number;
    resultComplete: boolean;
    scenario: ConversationProofCell["scenario"];
  },
): value is ValidatedConversationProofCell {
  if (!isRecord(value)) {
    return false;
  }
  const expectedKeys = [
    ...PUBLIC_CONVERSATION_PROOF_CELL_KEYS,
    ...(expected.scenario === "incomplete"
      ? (["globalOutboundMessageDelta", "globalOutboundValid"] as const)
      : []),
  ];
  const exact = expected.scenario === "exact";
  return (
    hasExactKeys(value, expectedKeys) &&
    value.id === expected.id &&
    value.scenario === expected.scenario &&
    value.ordinal === expected.ordinal &&
    value.mode === "code" &&
    value.passed === true &&
    value.promptSha256 === sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT) &&
    value.requestedTupleSha256 === canonicalSha256(CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE) &&
    isSha256(value.expectedAuthoredMethodsSha256) &&
    isSha256(value.authoredMethodsSha256) &&
    isSha256(value.execSourceSha256) &&
    isSha256(value.expectedAttemptedToolNamesSha256) &&
    isSha256(value.attemptedToolNamesSha256) &&
    value.attemptedToolNamesTruncated === false &&
    isSha256(value.nestedCallNamesSha256) &&
    isSha256(value.nestedCallTraceSha256) &&
    isPublicConversationProofSnapshot(value.registrySnapshot, expected.registeredRowCount) &&
    isPublicConversationProofSnapshot(value.listedRowsSnapshot, expected.listedRowCount) &&
    isSha256(value.returnedValueSha256) &&
    isSha256(value.outboundMessagesSha256) &&
    (exact ? isSha256(value.sendResultSha256) : value.sendResultSha256 === null) &&
    isSha256(value.rawEvidenceSha256) &&
    value.outerExecCalls === 1 &&
    value.completedOuterExecResults === 1 &&
    value.executedNestedToolCalls === expected.nestedCallCount &&
    value.outboundMessageDelta === expected.outboundMessageDelta &&
    isSha256(value.gatewayPidSha256) &&
    isSha256(value.sessionIdSha256) &&
    isSha256(value.agentIdSha256) &&
    isSha256(value.sessionKeySha256) &&
    isSha256(value.gatewayConfigSha256) &&
    isSha256(value.gatewayTempRootSha256) &&
    value.execObserved === true &&
    isSha256(value.finalSha256) &&
    value.finalReportsExpectedRefs === !exact &&
    value.returnedEnvelopeValid === true &&
    value.resultComplete === expected.resultComplete &&
    value.resultCompletenessReported === true &&
    value.requestedTupleValid === true &&
    value.candidateSetValid === true &&
    value.listedCandidateSetValid === true &&
    isSha256(value.candidateSetSha256) &&
    value.candidateSetSha256 === value.expectedCandidateSetSha256 &&
    isSha256(value.exactConversationRefSha256) &&
    isPublicConversationProofReceipt(value.receipt, exact) &&
    typeof value.elapsedMs === "number" &&
    value.elapsedMs >= 0 &&
    value.terminalStatus === "completed" &&
    value.terminalErrorPresent === false &&
    value.isError === false &&
    Array.isArray(value.candidateRefSha256) &&
    value.candidateRefSha256.length === expected.candidateCount &&
    value.candidateRefSha256.every(isSha256) &&
    isRecord(value.bindings) &&
    hasExactKeys(value.bindings, ["credentialBindingMatch", "profileMatch", "routeMatch"]) &&
    value.bindings.routeMatch === true &&
    value.bindings.profileMatch === true &&
    value.bindings.credentialBindingMatch === true &&
    isRecord(value.cleanup) &&
    hasExactKeys(value.cleanup, ["status"]) &&
    value.cleanup.status === "completed" &&
    (expected.scenario !== "incomplete" ||
      (value.globalOutboundMessageDelta === 1 && value.globalOutboundValid === true))
  );
}

export function validateCodeModeConversationProofSummary(
  summary: unknown,
  expected?: {
    buildSha256?: string;
    configSha256?: string;
    executionPolicy?: CodeModeConversationProofPolicy;
    gitSha?: string;
    model?: string;
  },
): { failureCode?: string; valid: boolean } {
  if (!isRecord(summary)) {
    return { valid: false, failureCode: "conversation_proof_summary_invalid" };
  }
  const executionPolicy = readConversationProofPolicy(summary.executionPolicy);
  const expectedPublicPolicy = expected?.executionPolicy
    ? publicConversationProofPolicy(expected.executionPolicy)
    : undefined;
  const expectedCells = [
    {
      candidateCount: 1,
      id: "Code-exact",
      listedRowCount: 6,
      nestedCallCount: 2,
      ordinal: 1,
      outboundMessageDelta: 1,
      registeredRowCount: 6,
      resultComplete: true,
      scenario: "exact",
    },
    {
      candidateCount: 2,
      id: "Code-ambiguous",
      listedRowCount: 7,
      nestedCallCount: 1,
      ordinal: 2,
      outboundMessageDelta: 0,
      registeredRowCount: 7,
      resultComplete: true,
      scenario: "ambiguous",
    },
    {
      candidateCount: 1,
      id: "Code-incomplete",
      listedRowCount: 100,
      nestedCallCount: 1,
      ordinal: 3,
      outboundMessageDelta: 0,
      registeredRowCount: 101,
      resultComplete: false,
      scenario: "incomplete",
    },
  ] as const;
  if (
    !hasExactKeys(summary, PUBLIC_CONVERSATION_PROOF_SUMMARY_KEYS) ||
    summary.schemaVersion !== 4 ||
    summary.evidenceClass !== "frontier_beta_qualification" ||
    summary.betaGateRole !== "required_separate_behavior_gate_excluded_from_abba_totals" ||
    summary.requestAudit !== "behavior_only_provider_request_unattested" ||
    summary.provider !== "openai" ||
    summary.runtime !== "openclaw" ||
    summary.api !== "openai-responses" ||
    summary.endpoint !== "https://api.openai.com/v1" ||
    summary.thinking !== "high" ||
    summary.credentialEnvName !== "OPENAI_API_KEY" ||
    !isSha256(summary.defaultAgentIdSha256) ||
    typeof summary.model !== "string" ||
    !isFrontierQualificationCandidateModel(summary.model) ||
    !isSha256(summary.authProfileIdSha256) ||
    !executionPolicy ||
    !expectedPublicPolicy ||
    !sameCanonicalValue(executionPolicy, expectedPublicPolicy) ||
    summary.api !== executionPolicy.api ||
    summary.credentialEnvName !== executionPolicy.credentialEnvName ||
    summary.defaultAgentIdSha256 !== executionPolicy.defaultAgentIdSha256 ||
    summary.endpoint !== executionPolicy.endpoint ||
    summary.model !== executionPolicy.model ||
    summary.provider !== executionPolicy.provider ||
    summary.runtime !== executionPolicy.runtime ||
    summary.thinking !== executionPolicy.thinking ||
    !isSha256(summary.buildSha256) ||
    !isSha256(summary.configSha256) ||
    summary.executionPolicySha256 !== canonicalSha256(executionPolicy) ||
    !isSha256(summary.gatewayConfigSha256) ||
    summary.promptSha256 !== sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT) ||
    summary.requestedTupleSha256 !==
      canonicalSha256(CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE) ||
    (expected?.buildSha256 !== undefined && summary.buildSha256 !== expected.buildSha256) ||
    (expected?.configSha256 !== undefined && summary.configSha256 !== expected.configSha256) ||
    (expected?.model !== undefined && summary.model !== expected.model) ||
    (expected?.gitSha !== undefined && summary.gitSha !== expected.gitSha) ||
    summary.sourceDirty !== false ||
    summary.routeMatch !== true ||
    summary.profileMatch !== true ||
    summary.credentialBindingMatch !== true ||
    summary.distinctGatewayPids !== true ||
    summary.distinctGatewayTempRoots !== true ||
    summary.distinctSessionIds !== true ||
    summary.distinctSessionKeys !== true ||
    summary.status !== "pass" ||
    summary.behaviorGateValidated !== true ||
    !isRecord(summary.qualification) ||
    !hasExactKeys(summary.qualification, ["betaRecommendation", "reason", "state"]) ||
    summary.qualification.state !== "not_eligible" ||
    summary.qualification.betaRecommendation !== "not_eligible" ||
    summary.qualification.reason !== "requires_matrix_beta_gate" ||
    !isRecord(summary.cleanup) ||
    !hasExactKeys(summary.cleanup, ["status"]) ||
    summary.cleanup.status !== "completed" ||
    !isRecord(summary.counts) ||
    !hasExactKeys(summary.counts, ["failed", "passed", "total"]) ||
    summary.counts.total !== 3 ||
    summary.counts.passed !== 3 ||
    summary.counts.failed !== 0 ||
    !Array.isArray(summary.cells) ||
    summary.cells.length !== 3
  ) {
    return { valid: false, failureCode: "conversation_proof_binding_mismatch" };
  }
  const cells = summary.cells;
  if (
    !cells.every((cell, index) => validatePublicConversationProofCell(cell, expectedCells[index]!))
  ) {
    return { valid: false, failureCode: "conversation_proof_cell_attestation_mismatch" };
  }
  const validatedCells = cells as ValidatedConversationProofCell[];
  const sessionHashes = validatedCells.map((cell) => cell.sessionIdSha256);
  const sessionKeyHashes = validatedCells.map((cell) => cell.sessionKeySha256);
  const gatewayPidHashes = validatedCells.map((cell) => cell.gatewayPidSha256);
  const gatewayTempRootHashes = validatedCells.map((cell) => cell.gatewayTempRootSha256);
  const hashLists = [
    [summary.gatewayPidSha256s, gatewayPidHashes],
    [summary.gatewayTempRootSha256s, gatewayTempRootHashes],
    [summary.sessionIdHashes, sessionHashes],
    [summary.sessionKeySha256s, sessionKeyHashes],
  ] as const;
  if (
    validatedCells.some((cell) => cell.gatewayConfigSha256 !== summary.gatewayConfigSha256) ||
    hashLists.some(
      ([actual, expectedHashes]) =>
        !Array.isArray(actual) ||
        actual.length !== 3 ||
        !actual.every(isSha256) ||
        !sameCanonicalValue(
          actual.toSorted((left, right) => left.localeCompare(right)),
          expectedHashes.toSorted((left, right) => left.localeCompare(right)),
        ),
    ) ||
    new Set(sessionHashes).size !== 3 ||
    new Set(sessionKeyHashes).size !== 3 ||
    new Set(gatewayPidHashes).size !== 3 ||
    new Set(gatewayTempRootHashes).size !== 3
  ) {
    return { valid: false, failureCode: "conversation_proof_global_invariant_mismatch" };
  }
  return { valid: true };
}

function evaluateGatewayBindings(params: {
  agentId: string;
  authProfileId: string;
  configuredPrimary: string;
  endpoint: string;
  expectedApi: string;
  frozenEnv: NodeJS.ProcessEnv;
  gatewayConfig: OpenClawConfig;
  runtimeEnv: NodeJS.ProcessEnv;
}) {
  const providerKeys = Object.keys(params.gatewayConfig.models?.providers ?? {}).toSorted();
  const defaultsModel = params.gatewayConfig.agents?.defaults?.model;
  const hasNoFallbacks =
    typeof defaultsModel === "object" &&
    defaultsModel !== null &&
    Array.isArray(defaultsModel.fallbacks) &&
    defaultsModel.fallbacks.length === 0;
  return {
    routeMatch:
      params.gatewayConfig.models?.mode === "replace" &&
      providerKeys.length === 1 &&
      providerKeys[0] === "openai" &&
      params.gatewayConfig.models?.providers?.openai?.baseUrl === params.endpoint &&
      params.gatewayConfig.models?.providers?.openai?.api === params.expectedApi &&
      resolveAgentEffectiveModelPrimary(params.gatewayConfig, params.agentId) ===
        params.configuredPrimary &&
      hasNoFallbacks,
    profileMatch:
      params.gatewayConfig.auth?.profiles?.[params.authProfileId]?.provider === "openai" &&
      params.gatewayConfig.auth.profiles[params.authProfileId]?.mode === "api_key",
    credentialBindingMatch:
      typeof params.frozenEnv.OPENAI_API_KEY === "string" &&
      params.frozenEnv.OPENAI_API_KEY.length > 0 &&
      params.runtimeEnv.OPENAI_API_KEY === params.frozenEnv.OPENAI_API_KEY,
  };
}

function canonicalOpenAiProvider(params: CodeModeConversationProofParams): ModelProviderConfig {
  const configured = params.config.models?.providers?.openai;
  return {
    ...configured,
    api: configured?.api ?? params.executionPolicy.api,
    auth: configured?.auth ?? ("api-key" as const),
    baseUrl: configured?.baseUrl ?? params.executionPolicy.endpoint,
    models: configured?.models ?? [],
  };
}

function requireConversationIdentity(
  input: Parameters<typeof buildConversationIdentity>[0],
): ConversationProofIdentity {
  const identity = buildConversationIdentity(input);
  if (!identity) {
    throw new Error("conversation_proof_identity_invalid");
  }
  return identity;
}

function registerConversationProofScenario(params: {
  registryScope: { agentId: string; env: NodeJS.ProcessEnv };
  scenario: ConversationProofCell["scenario"];
}): ConversationProofCandidate[] {
  const readRegistryRows = () =>
    listConversations(params.registryScope, { limit: 200 }).map((record) => ({
      conversationRef: record.conversationRef,
      channel: record.channel,
      accountId: record.accountId,
      kind: record.kind,
      target: record.target,
      threadId: record.threadId ?? null,
    }));
  const firstIdentity = requireConversationIdentity({
    channel: "qa-channel",
    accountId: "default",
    kind: "direct",
    peerId: "build-bot",
    deliveryTarget: "dm:build-bot",
    label: "Primary route",
  });
  const secondIdentity = requireConversationIdentity({
    channel: "qa-channel",
    accountId: "default",
    kind: "direct",
    peerId: "build-bot-shadow",
    deliveryTarget: "dm:build-bot",
    label: "Shadow route",
  });
  const exactDecoys = [
    requireConversationIdentity({
      channel: "qa-channel",
      accountId: "default",
      kind: "direct",
      peerId: "label-decoy",
      deliveryTarget: "dm:other",
      label: "dm:build-bot",
    }),
    requireConversationIdentity({
      channel: "qa-channel",
      accountId: "default",
      kind: "direct",
      peerId: "thread-decoy",
      deliveryTarget: "dm:build-bot",
      threadId: "thread-other",
      label: "Thread route",
    }),
    requireConversationIdentity({
      channel: "qa-channel-shadow",
      accountId: "default",
      kind: "direct",
      peerId: "channel-decoy",
      deliveryTarget: "dm:build-bot",
      label: "Channel route",
    }),
    requireConversationIdentity({
      channel: "qa-channel",
      accountId: "secondary",
      kind: "direct",
      peerId: "account-decoy",
      deliveryTarget: "dm:build-bot",
      label: "Account route",
    }),
    requireConversationIdentity({
      channel: "qa-channel",
      accountId: "default",
      kind: "group",
      peerId: "kind-decoy",
      deliveryTarget: "dm:build-bot",
      label: "Kind route",
    }),
  ];
  const registerOrdered = (
    identities: readonly ConversationProofIdentity[],
    newestDiscoveredAt: number,
  ) => {
    for (const [index, identity] of identities.entries()) {
      registerConversationAddresses(params.registryScope, [identity], newestDiscoveredAt - index);
    }
  };
  if (params.scenario === "exact") {
    const identities = [...exactDecoys.slice(0, 2), firstIdentity, ...exactDecoys.slice(2)];
    registerOrdered(identities, 200);
    return readRegistryRows();
  }
  if (params.scenario === "ambiguous") {
    registerOrdered([...exactDecoys, secondIdentity, firstIdentity], 300);
    return readRegistryRows();
  }
  const visibleDecoys = Array.from({ length: 99 }, (_, index) =>
    requireConversationIdentity({
      channel: "qa-channel",
      accountId: `incomplete-decoy-${String(index).padStart(3, "0")}`,
      kind: "direct",
      peerId: `incomplete-decoy-${String(index).padStart(3, "0")}`,
      deliveryTarget: "dm:build-bot",
      label: `Incomplete decoy ${String(index).padStart(3, "0")}`,
    }),
  );
  const omittedDecoy = requireConversationIdentity({
    channel: "qa-channel",
    accountId: "incomplete-omitted",
    kind: "direct",
    peerId: "incomplete-omitted",
    deliveryTarget: "dm:build-bot",
    label: "Incomplete omitted decoy",
  });
  const visibleIdentities = [firstIdentity, ...visibleDecoys];
  registerConversationAddresses(params.registryScope, [omittedDecoy], 100);
  registerOrdered(visibleIdentities, 300);
  return readRegistryRows();
}

function gatewayBindingSha256(config: OpenClawConfig): string {
  const agents = structuredClone(config.agents);
  if (isRecord(agents?.defaults)) {
    delete agents.defaults.workspace;
  }
  return sha256(
    canonicalJson({
      agents,
      auth: config.auth,
      models: config.models,
      tools: config.tools,
    }),
  );
}

async function writeConversationProofSummary(outputDir: string, summary: unknown): Promise<void> {
  await fs.writeFile(
    path.join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
}

function applyConversationProofCleanupOutcome(
  summary: ConversationProofSummary,
  cleanupFailed: boolean,
): ConversationProofSummary {
  if (!cleanupFailed) {
    return { ...summary, cleanup: { status: "completed" } };
  }
  return {
    ...summary,
    status: summary.status === "blocked" ? "blocked" : "fail",
    failureCode: summary.failureCode ?? "conversation_proof_cleanup_failed",
    cleanup: {
      status: "failed",
      failureCode: "conversation_proof_cleanup_failed",
    },
  };
}

function firstConversationProofFailureCode(cells: readonly ConversationProofCell[]): string {
  const failedCell = cells.find((cell) => !cell.passed);
  return typeof failedCell?.failureCode === "string"
    ? failedCell.failureCode
    : "conversation_proof_cell_failed";
}

export async function runCodeModeMatrixConversationProof(params: CodeModeConversationProofParams) {
  const outputDir = path.join(params.outputDir, "conversation-proof");
  await fs.mkdir(outputDir, { recursive: true });
  const baseSummary = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    model: params.model,
    provider: "openai" as const,
    runtime: "openclaw" as const,
    api: params.executionPolicy.api,
    endpoint: params.executionPolicy.endpoint,
    thinking: params.executionPolicy.thinking,
    defaultAgentIdSha256: sha256(params.executionPolicy.defaultAgentId),
    credentialEnvName: params.executionPolicy.credentialEnvName,
    gitSha: params.gitSha,
    sourceDirty: false,
    buildSha256: params.buildSha256,
    configSha256: params.configSha256,
    executionPolicy: publicConversationProofPolicy(params.executionPolicy),
    executionPolicySha256: sha256(
      canonicalJson(publicConversationProofPolicy(params.executionPolicy)),
    ),
    promptSha256: sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT),
    requestedTupleSha256: sha256(canonicalJson(CODE_MODE_CONVERSATION_PROOF_REQUESTED_TUPLE)),
    evidenceClass: "frontier_beta_qualification" as const,
    requestAudit: "behavior_only_provider_request_unattested" as const,
    betaGateRole: "required_separate_behavior_gate_excluded_from_abba_totals" as const,
  };
  let cells: ConversationProofCell[] = [];
  let summary: ConversationProofSummary;
  try {
    if (
      !isFrontierQualificationCandidateModel(params.model) ||
      params.executionPolicy.model !== params.model
    ) {
      throw new Error("conversation_proof_model_unsupported");
    }
    const configuredPrimary = resolveAgentEffectiveModelPrimary(
      params.config,
      params.executionPolicy.defaultAgentId,
    );
    if (!configuredPrimary) {
      throw new Error("conversation_proof_frozen_route_missing");
    }
    const qualifiedPrimary = splitTrailingAuthProfile(configuredPrimary);
    const authProfileId = qualifiedPrimary.profile;
    const pinnedModelEntry = params.config.agents?.defaults?.models?.[params.model];
    const pinnedAuthProfile = authProfileId
      ? params.config.auth?.profiles?.[authProfileId]
      : undefined;
    if (qualifiedPrimary.model !== params.model || !authProfileId || !pinnedAuthProfile) {
      throw new Error("conversation_proof_frozen_route_missing");
    }
    const provider = canonicalOpenAiProvider(params);
    cells = await runConversationProofCells({
      runScenario: async (definition, ordinal) => {
        let lab: Awaited<ReturnType<typeof startQaLabServer>> | undefined;
        let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
        let gatewayPidSha256 = "";
        let gatewayTempRootSha256 = "";
        let bindingSha256 = "";
        let bindings = {
          routeMatch: false,
          profileMatch: false,
          credentialBindingMatch: false,
        };
        let cell: ConversationProofCell;
        let cleanupFailed = false;
        try {
          lab = await startQaLabServer({
            repoRoot: params.repoRoot,
            embeddedGateway: "disabled",
          });
          const transport = createQaChannelTransport(lab.state);
          gateway = await startQaGatewayChild({
            repoRoot: params.repoRoot,
            transport,
            transportBaseUrl: lab.listenUrl,
            providerMode: "live-frontier",
            primaryModel: params.model,
            alternateModel: params.model,
            thinkingDefault: params.executionPolicy.thinking,
            forcedRuntime: "openclaw",
            controlUiEnabled: false,
            keepTemp: false,
            runtimeBaseEnv: params.frozenEnv,
            mutateConfig: (config) => ({
              ...config,
              models: {
                mode: "replace",
                providers: { openai: provider },
              },
              auth: {
                ...config.auth,
                profiles: { [authProfileId]: pinnedAuthProfile },
              },
              agents: {
                ...config.agents,
                defaults: {
                  ...config.agents?.defaults,
                  model: { primary: configuredPrimary, fallbacks: [] },
                  models: {
                    [params.model]: pinnedModelEntry ?? { agentRuntime: { id: "openclaw" } },
                  },
                },
                entries: {
                  ...config.agents?.entries,
                  [params.executionPolicy.defaultAgentId]: {
                    ...config.agents?.entries?.[params.executionPolicy.defaultAgentId],
                    model: configuredPrimary,
                    tools: {
                      ...config.agents?.entries?.[params.executionPolicy.defaultAgentId]?.tools,
                      codeMode: { enabled: true },
                    },
                  },
                },
              },
              tools: {
                profile: "coding",
                alsoAllow: ["conversations_list", "conversations_send"],
                codeMode: { enabled: true },
              },
            }),
          });
          gatewayTempRootSha256 = sha256(gateway.tempRoot);
          const agentDir = path.join(
            gateway.tempRoot,
            "state",
            "agents",
            params.executionPolicy.defaultAgentId,
            "agent",
          );
          const authStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
            allowKeychainPrompt: false,
            syncExternalCli: false,
          });
          authStore.profiles[authProfileId] = {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            displayName: "Frozen Code Mode proof credential",
          };
          saveAuthProfileStore(authStore, agentDir);
          const gatewayConfig = JSON.parse(
            await fs.readFile(gateway.configPath, "utf8"),
          ) as OpenClawConfig;
          bindingSha256 = gatewayBindingSha256(gatewayConfig);
          bindings = evaluateGatewayBindings({
            agentId: params.executionPolicy.defaultAgentId,
            authProfileId,
            configuredPrimary,
            endpoint: params.executionPolicy.endpoint,
            expectedApi: params.executionPolicy.api,
            frozenEnv: params.frozenEnv,
            gatewayConfig,
            runtimeEnv: gateway.runtimeEnv,
          });
          if (!bindings.routeMatch || !bindings.profileMatch || !bindings.credentialBindingMatch) {
            throw new Error("conversation_proof_gateway_route_mismatch");
          }
          if (!gateway.pid) {
            throw new Error("conversation_proof_gateway_pid_missing");
          }
          gatewayPidSha256 = sha256(String(gateway.pid));
          const registryRows = registerConversationProofScenario({
            registryScope: {
              agentId: params.executionPolicy.defaultAgentId,
              env: { OPENCLAW_STATE_DIR: path.join(gateway.tempRoot, "state") },
            },
            scenario: definition.scenario,
          });
          cell = await runConversationProofCell({
            agentId: params.executionPolicy.defaultAgentId,
            callGateway: async (method, request, options) =>
              await gateway!.call(method, request, options),
            gatewayPidSha256,
            getSnapshot: () => lab!.state.getSnapshot(),
            ordinal,
            readTranscript: async (runtimeIdentity) =>
              await readConversationProofTranscript({
                ...runtimeIdentity,
                gatewayTempRoot: gateway!.tempRoot,
              }),
            registryRows,
            scenario: definition.scenario,
            thinking: params.executionPolicy.thinking,
          });
        } catch (error) {
          cell = {
            id: definition.id,
            scenario: definition.scenario,
            mode: "code",
            promptSha256: sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT),
            gatewayPidSha256,
            execObserved: false,
            elapsedMs: 0,
            failureCode: stableFailureCode(error),
            passed: false,
            ordinal,
          };
        } finally {
          try {
            await gateway?.stop({ keepTemp: false });
          } catch {
            cleanupFailed = true;
          }
          try {
            await lab?.stop();
          } catch {
            cleanupFailed = true;
          }
        }
        return {
          ...cell!,
          gatewayConfigSha256: bindingSha256,
          gatewayTempRootSha256,
          bindings,
          cleanup: cleanupFailed
            ? {
                status: "failed",
                failureCode: "conversation_proof_cleanup_failed",
              }
            : { status: "completed" },
          passed: cell!.passed && !cleanupFailed,
          ...(cleanupFailed && !cell!.failureCode
            ? { failureCode: "conversation_proof_cleanup_failed" }
            : {}),
        };
      },
    });
    const failed = cells.filter((cell) => !cell.passed).length;
    const sessionIdHashes = cells
      .flatMap((cell) => (typeof cell.sessionIdSha256 === "string" ? [cell.sessionIdSha256] : []))
      .toSorted();
    const sessionKeySha256s = cells
      .flatMap((cell) => (typeof cell.sessionKeySha256 === "string" ? [cell.sessionKeySha256] : []))
      .toSorted();
    const gatewayPidSha256s = cells
      .flatMap((cell) =>
        typeof cell.gatewayPidSha256 === "string" && cell.gatewayPidSha256.length > 0
          ? [cell.gatewayPidSha256]
          : [],
      )
      .toSorted();
    const gatewayConfigSha256s = cells
      .flatMap((cell) =>
        typeof cell.gatewayConfigSha256 === "string" && cell.gatewayConfigSha256.length > 0
          ? [cell.gatewayConfigSha256]
          : [],
      )
      .toSorted();
    const gatewayTempRootSha256s = cells
      .flatMap((cell) =>
        typeof cell.gatewayTempRootSha256 === "string" && cell.gatewayTempRootSha256.length > 0
          ? [cell.gatewayTempRootSha256]
          : [],
      )
      .toSorted();
    const distinctSessionIds =
      sessionIdHashes.length === 3 && new Set(sessionIdHashes).size === sessionIdHashes.length;
    const distinctSessionKeys =
      sessionKeySha256s.length === 3 &&
      new Set(sessionKeySha256s).size === sessionKeySha256s.length;
    const distinctGatewayPids =
      gatewayPidSha256s.length === 3 &&
      new Set(gatewayPidSha256s).size === gatewayPidSha256s.length;
    const distinctGatewayTempRoots =
      gatewayTempRootSha256s.length === 3 &&
      new Set(gatewayTempRootSha256s).size === gatewayTempRootSha256s.length;
    const commonGatewayConfig =
      gatewayConfigSha256s.length === 3 && new Set(gatewayConfigSha256s).size === 1
        ? gatewayConfigSha256s[0]
        : undefined;
    const routeMatch =
      cells.length === 3 &&
      cells.every((cell) => isRecord(cell.bindings) && cell.bindings.routeMatch);
    const profileMatch =
      cells.length === 3 &&
      cells.every((cell) => isRecord(cell.bindings) && cell.bindings.profileMatch);
    const credentialBindingMatch =
      cells.length === 3 &&
      cells.every((cell) => isRecord(cell.bindings) && cell.bindings.credentialBindingMatch);
    const cleanupCompleted =
      cells.length === 3 &&
      cells.every((cell) => isRecord(cell.cleanup) && cell.cleanup.status === "completed");
    const passed =
      cells.length === 3 &&
      failed === 0 &&
      distinctSessionIds &&
      distinctSessionKeys &&
      distinctGatewayPids &&
      distinctGatewayTempRoots &&
      commonGatewayConfig !== undefined &&
      routeMatch &&
      profileMatch &&
      credentialBindingMatch &&
      cleanupCompleted;
    summary = {
      ...baseSummary,
      status: passed ? ("pass" as const) : ("fail" as const),
      ...(!passed
        ? {
            failureCode:
              failed > 0
                ? firstConversationProofFailureCode(cells)
                : !cleanupCompleted
                  ? "conversation_proof_cleanup_failed"
                  : "conversation_proof_global_invariant_mismatch",
          }
        : {}),
      authProfileIdSha256: sha256(authProfileId),
      gatewayConfigSha256: commonGatewayConfig,
      gatewayPidSha256s,
      distinctGatewayPids,
      gatewayTempRootSha256s,
      distinctGatewayTempRoots,
      routeMatch,
      profileMatch,
      credentialBindingMatch,
      sessionIdHashes,
      distinctSessionIds,
      sessionKeySha256s,
      distinctSessionKeys,
      cleanup: cleanupCompleted
        ? { status: "completed" }
        : { status: "failed", failureCode: "conversation_proof_cleanup_failed" },
      cells,
      counts: { total: cells.length, passed: cells.length - failed, failed },
    };
  } catch (error) {
    const failed = cells.filter((cell) => !cell.passed).length;
    summary = {
      ...baseSummary,
      status: cells.length === 0 ? ("blocked" as const) : ("fail" as const),
      failureCode: stableFailureCode(error),
      cleanup: { status: "completed" },
      cells,
      counts: { total: cells.length, passed: cells.length - failed, failed },
    };
  }
  const behaviorGateValidation = validateRawCodeModeConversationProofSummary(summary, {
    buildSha256: params.buildSha256,
    configSha256: params.configSha256,
    executionPolicy: params.executionPolicy,
    gitSha: params.gitSha,
    model: params.model,
  });
  if (summary.status === "pass" && !behaviorGateValidation.valid) {
    summary = {
      ...summary,
      status: "fail",
      failureCode:
        summary.failureCode ??
        behaviorGateValidation.failureCode ??
        "conversation_proof_behavior_gate_invalid",
    };
  }
  summary = {
    ...summary,
    behaviorGateValidated: behaviorGateValidation.valid,
    qualification:
      summary.status === "pass" && behaviorGateValidation.valid
        ? {
            state: "not_eligible",
            betaRecommendation: "not_eligible",
            reason: "requires_matrix_beta_gate",
          }
        : {
            state: "not_eligible",
            betaRecommendation: "not_eligible",
            reason: "conversation_proof_not_completed",
          },
  };
  let publicSummary = projectConversationProofSummary(summary);
  const publicValidation = validateCodeModeConversationProofSummary(publicSummary, {
    buildSha256: params.buildSha256,
    configSha256: params.configSha256,
    executionPolicy: params.executionPolicy,
    gitSha: params.gitSha,
    model: params.model,
  });
  if (publicSummary.status === "pass" && !publicValidation.valid) {
    publicSummary = {
      ...publicSummary,
      status: "fail",
      failureCode:
        publicSummary.failureCode ??
        publicValidation.failureCode ??
        "conversation_proof_public_artifact_invalid",
      behaviorGateValidated: false,
      qualification: {
        state: "not_eligible",
        betaRecommendation: "not_eligible",
        reason: "conversation_proof_not_completed",
      },
    };
  }
  await writeConversationProofSummary(outputDir, publicSummary);
  return publicSummary;
}

export const codeModeConversationProofTesting = {
  applyConversationProofCleanupOutcome,
  canonicalOpenAiProvider,
  evaluateConversationProofCell,
  evaluateGatewayBindings,
  firstConversationProofFailureCode,
  gatewayBindingSha256,
  projectConversationProofSummary,
  readAuthoredMethods,
  readConversationProofTranscript,
  readToolCallInput,
  registerConversationProofScenario,
  runConversationProofCell,
  runConversationProofCells,
  stableFailureCode,
  validateCodeModeConversationProofSummary,
  validateRawCodeModeConversationProofSummary,
};
