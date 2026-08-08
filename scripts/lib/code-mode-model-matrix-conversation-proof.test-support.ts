import { createHash } from "node:crypto";
import type { FrontierCodeModeCapabilityReceipt } from "./code-mode-frontier-model-qualification.js";
import {
  CODE_MODE_CONVERSATION_PROOF_PROMPT,
  codeModeConversationProofTesting,
  type CodeModeConversationProofPolicy,
} from "./code-mode-model-matrix-conversation-proof.js";

const REQUESTED_TUPLE = {
  channel: "qa-channel",
  accountId: "default",
  kind: "direct",
  target: "dm:build-bot",
  threadId: null,
} as const;

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

type ConversationProofNestedCall = {
  input: unknown;
  name: "conversations_list" | "conversations_send";
  result: unknown;
};

type ValidatedConversationProofCell = Record<string, unknown> & {
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeConversationRef(label: string): string {
  return `conv_${sha256(label).slice(0, 32)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function canonicalPolicy(policy: CodeModeConversationProofPolicy): CodeModeConversationProofPolicy {
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

export function createFrontierCodeModeCapabilityReceiptFixture(
  modelRef = "openai/gpt-5.6",
): FrontierCodeModeCapabilityReceipt {
  return {
    api: "openai-responses",
    codeMode: "preferred",
    endpoint: "https://api.openai.com/v1",
    manifestPath: "extensions/openai/openclaw.plugin.json",
    manifestSha256: "3".repeat(64),
    modelRef,
    modelRowSha256: "4".repeat(64),
    source: "bundled_openai_manifest",
    status: "available",
    version: 1,
  };
}

function publicPolicy(policy: CodeModeConversationProofPolicy) {
  const canonical = canonicalPolicy(policy);
  const { defaultAgentId, ...rest } = canonical;
  return {
    ...rest,
    defaultAgentIdSha256: sha256(defaultAgentId),
  };
}

type ConversationProofFixtureParams = {
  buildSha256?: string;
  configSha256?: string;
  executionPolicy?: CodeModeConversationProofPolicy;
  gitSha: string;
  model?: string;
};

export function createValidRawConversationProofSummaryFixture(
  params: ConversationProofFixtureParams,
) {
  const model = params.model ?? "openai/gpt-5.6";
  const executionPolicy = canonicalPolicy(
    params.executionPolicy ?? {
      api: "openai-responses",
      authMode: "api_key",
      authBindingId: "1".repeat(32),
      cachePolicy: {
        build: "shared_immutable",
        os: "uncontrolled",
        provider: "uncontrolled",
      },
      candidateRuntime: "embedded",
      codeModeActivation: "explicit_frozen_run_config",
      codeModeCapability: createFrontierCodeModeCapabilityReceiptFixture(model),
      concurrency: 1,
      credentialEnvName: "OPENAI_API_KEY",
      defaultAgentId: "main",
      endpoint: "https://api.openai.com/v1",
      environmentPolicySha256: "2".repeat(64),
      fallbacks: "disabled",
      harnessRetries: 0,
      model,
      processState: "fresh_per_cell",
      provider: "openai",
      providerRetryPolicy: "openai-responses-runtime-default",
      runtime: "openclaw",
      schedule: "serial_abba",
      seed: "unsupported_unset",
      selectorSource: "config",
      thinking: "high",
    },
  );
  const sessionKeyFor = (id: string) =>
    `agent:${executionPolicy.defaultAgentId}:code-mode-conversation-${id.toLowerCase()}`;
  const requested = REQUESTED_TUPLE;
  const makeCandidate = (
    conversationRef: string,
    overrides: Partial<ConversationProofTuple> = {},
  ): ConversationProofCandidate => ({
    conversationRef,
    ...requested,
    ...overrides,
  });
  const first = makeCandidate(makeConversationRef("exact"));
  const second = makeCandidate(makeConversationRef("ambiguous"));
  const exactDecoys = [
    makeCandidate(makeConversationRef("channel-decoy"), { channel: "qa-channel-shadow" }),
    makeCandidate(makeConversationRef("account-decoy"), { accountId: "secondary" }),
    makeCandidate(makeConversationRef("kind-decoy"), { kind: "group" }),
    makeCandidate(makeConversationRef("target-decoy"), { target: "dm:other" }),
    makeCandidate(makeConversationRef("thread-decoy"), { threadId: "thread-other" }),
  ];
  const exactRows = [...exactDecoys.slice(0, 2), first, ...exactDecoys.slice(2)];
  const ambiguousRows = [...exactDecoys, second, first];
  const incompleteRows = [
    first,
    ...Array.from({ length: 99 }, (_, index) =>
      makeCandidate(makeConversationRef(`incomplete-${String(index).padStart(3, "0")}`), {
        accountId: `incomplete-${String(index).padStart(3, "0")}`,
      }),
    ),
  ];
  const incompleteOmitted = makeCandidate(makeConversationRef("incomplete-omitted"), {
    accountId: "incomplete-omitted",
  });
  const finalFor = (
    header: "AMBIGUOUS_NO_SEND" | "INCOMPLETE_NO_SEND",
    candidates: ConversationProofCandidate[],
  ) =>
    [
      header,
      ...candidates
        .toSorted((left, right) => left.conversationRef.localeCompare(right.conversationRef))
        .map(
          (candidate) =>
            `${candidate.conversationRef}\t${candidate.channel}\t${candidate.accountId}\t${candidate.kind}\t${candidate.target}\t${candidate.threadId ?? ""}`,
        ),
    ].join("\n");
  const bindingSha256 = sha256("conversation-proof-gateway-binding");
  const bindings = {
    routeMatch: true,
    profileMatch: true,
    credentialBindingMatch: true,
  };
  const cleanup = { status: "completed" as const };
  const execSource = `
const requested = { channel: "qa-channel", accountId: "default", kind: "direct", target: "dm:build-bot", threadId: null };
const listed = await tools.conversations_list({ query: requested.target, limit: 100 });
const rows = Array.isArray(listed.conversations) ? listed.conversations : [];
const resultComplete = rows.length < 100;
const candidates = rows
  .map(({ conversationRef, channel, accountId, kind, target, threadId }) => ({
    conversationRef,
    channel,
    accountId,
    kind,
    target,
    threadId: threadId ?? null,
  }))
  .filter((row) =>
    row.channel === requested.channel &&
    row.accountId === requested.accountId &&
    row.kind === requested.kind &&
    row.target === requested.target &&
    row.threadId === requested.threadId
  )
  .sort((left, right) => left.conversationRef.localeCompare(right.conversationRef));
if (resultComplete && candidates.length === 1) {
  const sendResult = await tools.conversations_send({
    conversationRef: candidates[0].conversationRef,
    message: "Build finished.",
  });
  return { requested, resultComplete, candidates, sendResult };
}
return { requested, resultComplete, candidates };
`.trim();
  const exactReceipt = {
    status: "sent",
    conversationRef: first.conversationRef,
    channel: requested.channel,
    messageId: "message-exact",
  };
  const cellInputs = [
    {
      scenario: "exact" as const,
      registeredRows: exactRows,
      listedRows: exactRows,
      attemptedToolNames: ["conversations_list", "conversations_send"],
      finalText: "SENT",
      value: {
        requested,
        resultComplete: true,
        candidates: [first],
        sendResult: exactReceipt,
      },
      outboundMessages: [
        {
          accountId: requested.accountId,
          id: exactReceipt.messageId,
          conversation: { id: "build-bot", kind: requested.kind },
          direction: "outbound",
          text: "Build finished.",
        },
      ],
    },
    {
      scenario: "ambiguous" as const,
      registeredRows: ambiguousRows,
      listedRows: ambiguousRows,
      attemptedToolNames: ["conversations_list"],
      finalText: finalFor("AMBIGUOUS_NO_SEND", [first, second]),
      value: {
        requested,
        resultComplete: true,
        candidates: [first, second].toSorted((left, right) =>
          left.conversationRef.localeCompare(right.conversationRef),
        ),
      },
      outboundMessages: [],
    },
    {
      scenario: "incomplete" as const,
      registeredRows: [...incompleteRows, incompleteOmitted],
      listedRows: incompleteRows,
      attemptedToolNames: ["conversations_list"],
      finalText: finalFor("INCOMPLETE_NO_SEND", [first]),
      value: {
        requested,
        resultComplete: false,
        candidates: [first],
      },
      outboundMessages: [],
    },
  ];
  const cells = cellInputs.map((input, index) => {
    const elapsedMs = 10 + index;
    const gatewayPidSha256 = sha256(`gateway-${input.scenario}`);
    const sessionIdSha256 = sha256(`session-${input.scenario}`);
    const nestedCalls: ConversationProofNestedCall[] = [
      {
        name: "conversations_list",
        input: { query: requested.target, limit: 100 },
        result: { conversations: input.listedRows },
      },
      ...(input.scenario === "exact"
        ? [
            {
              name: "conversations_send" as const,
              input: {
                conversationRef: first.conversationRef,
                message: "Build finished.",
              },
              result: exactReceipt,
            },
          ]
        : []),
    ];
    return Object.assign(
      codeModeConversationProofTesting.evaluateConversationProofCell({
        authoredMethods: ["conversations_list", "conversations_send"],
        callCount: input.attemptedToolNames.length,
        completedExecResultCount: 1,
        elapsedMs,
        attemptedToolNames: input.attemptedToolNames,
        attemptedToolNamesTruncated: false,
        execCallCount: 1,
        execSource,
        finalText: input.finalText,
        gatewayPidSha256,
        isError: false,
        nestedCalls,
        newOutboundMessages: input.outboundMessages,
        ordinal: index + 1,
        registeredRows: input.registeredRows,
        scenario: input.scenario,
        sessionIdSha256,
        terminalErrorPresent: false,
        terminalStatus: "completed",
        value: input.value,
      }),
      {
        agentIdSha256: sha256(executionPolicy.defaultAgentId),
        elapsedMs,
        executedNestedToolCalls: input.attemptedToolNames.length,
        gatewayConfigSha256: bindingSha256,
        gatewayPidSha256,
        gatewayTempRootSha256: sha256(`gateway-root-${input.scenario}`),
        outboundMessageDelta: input.outboundMessages.length,
        sessionIdSha256,
        sessionKeySha256: sha256(sessionKeyFor(`Code-${input.scenario}`)),
        bindings,
        cleanup,
      },
    ) satisfies ValidatedConversationProofCell;
  });
  cells[2] = {
    ...cells[2]!,
    globalOutboundMessageDelta: 1,
    globalOutboundValid: true,
  };
  return {
    schemaVersion: 3,
    generatedAt: "2026-08-07T00:00:00.000Z",
    model,
    provider: "openai",
    runtime: "openclaw",
    api: executionPolicy.api,
    endpoint: executionPolicy.endpoint,
    thinking: executionPolicy.thinking,
    defaultAgentIdSha256: sha256(executionPolicy.defaultAgentId),
    credentialEnvName: executionPolicy.credentialEnvName,
    authProfileIdSha256: sha256("openai:matrix"),
    gitSha: params.gitSha,
    sourceDirty: false,
    buildSha256: params.buildSha256 ?? sha256("build"),
    configSha256: params.configSha256 ?? sha256("config"),
    executionPolicySha256: sha256(canonicalJson(publicPolicy(executionPolicy))),
    executionPolicy: publicPolicy(executionPolicy),
    promptSha256: sha256(CODE_MODE_CONVERSATION_PROOF_PROMPT),
    requestedTupleSha256: sha256(canonicalJson(requested)),
    evidenceClass: "frontier_beta_qualification",
    requestAudit: "behavior_only_provider_request_unattested",
    betaGateRole: "required_separate_behavior_gate_excluded_from_abba_totals",
    status: "pass" as const,
    gatewayConfigSha256: bindingSha256,
    gatewayPidSha256s: cells
      .map((cell) => cell.gatewayPidSha256)
      .toSorted((left, right) => left.localeCompare(right)),
    distinctGatewayPids: true,
    gatewayTempRootSha256s: cells
      .map((cell) => cell.gatewayTempRootSha256)
      .toSorted((left, right) => left.localeCompare(right)),
    distinctGatewayTempRoots: true,
    routeMatch: true,
    profileMatch: true,
    credentialBindingMatch: true,
    sessionIdHashes: cells
      .map((cell) => cell.sessionIdSha256)
      .toSorted((left, right) => left.localeCompare(right)),
    distinctSessionIds: true,
    sessionKeySha256s: cells
      .map((cell) => cell.sessionKeySha256)
      .toSorted((left, right) => left.localeCompare(right)),
    distinctSessionKeys: true,
    cleanup,
    cells,
    counts: { total: 3, passed: 3, failed: 0 },
    behaviorGateValidated: true,
  };
}

export function createValidConversationProofSummaryFixture(params: ConversationProofFixtureParams) {
  const rawSummary = createValidRawConversationProofSummaryFixture(params);
  const validation = codeModeConversationProofTesting.validateRawCodeModeConversationProofSummary(
    rawSummary,
    {
      buildSha256: rawSummary.buildSha256,
      configSha256: rawSummary.configSha256,
      executionPolicy:
        params.executionPolicy ??
        ({
          ...rawSummary.executionPolicy,
          defaultAgentId: "main",
        } as CodeModeConversationProofPolicy),
      gitSha: params.gitSha,
      model: params.model ?? "openai/gpt-5.6",
    },
  );
  return codeModeConversationProofTesting.projectConversationProofSummary({
    ...rawSummary,
    behaviorGateValidated: validation.valid,
    qualification:
      rawSummary.status === "pass" && validation.valid
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
  });
}
