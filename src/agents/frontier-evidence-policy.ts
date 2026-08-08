import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { FrontierEvidenceBinding } from "./frontier-evidence-transport-policy.js";

const FRONTIER_EVIDENCE_POLICY_VERSION = 1 as const;

export type FrontierEvidencePolicy = {
  version: typeof FRONTIER_EVIDENCE_POLICY_VERSION;
  policySha256: string;
  configSha256: string;
  defaultAgentId: string;
  provider: "openai";
  model: string;
  api: "openai-responses";
  baseUrl: "https://api.openai.com/v1";
  runtime: "openclaw";
  authBindingId: string;
  contentDigestKey: string;
  credentialState: "frozen_in_memory";
  credentialEnvName: "OPENAI_API_KEY";
  fallbacks: "disabled";
  proxy: "disabled";
  tls: "default";
  localService: "disabled";
  endpoint: {
    origin: "https://api.openai.com";
    pathname: "/v1/responses";
    method: "POST";
    transport: "responses-sdk";
  };
  thinking: "high";
  seed: "absent";
  authoredRequestParams: "absent";
  maxLogicalCalls: number;
  expectedReasoning: { effort: "high"; summary: "auto" };
  expectedInclude: ["reasoning.encrypted_content"];
  expectedMetadata: {
    source: "openai_transport_turn_state";
    keys: [
      "openclaw_session_id",
      "openclaw_transport",
      "openclaw_turn_attempt",
      "openclaw_turn_id",
    ];
    valueClass: "volatile_execution_metadata";
  };
  expectedToolChoice: "absent";
  expectedPromptCacheKey: "session_boundary";
  expectedPromptCacheRetention: "absent";
  expectedMaxRetries: 2;
};

type FrontierEvidenceScope = {
  policy: FrontierEvidencePolicy;
  expectedAuthProfileId: string;
  bindings: FrontierEvidenceBinding[];
  taskDigest?: string;
};

const frontierEvidencePolicy = new AsyncLocalStorage<FrontierEvidenceScope>();
export function runWithFrontierEvidencePolicy<T>(
  policy: FrontierEvidencePolicy,
  expectedAuthProfileId: string,
  run: () => T,
  taskDigest?: string,
): T {
  return frontierEvidencePolicy.run(
    { policy, expectedAuthProfileId, bindings: [], taskDigest },
    run,
  );
}

export function getFrontierEvidencePolicy(): FrontierEvidencePolicy | undefined {
  return frontierEvidencePolicy.getStore()?.policy;
}

export function getFrontierEvidenceExpectedAuthProfileId(): string | undefined {
  return frontierEvidencePolicy.getStore()?.expectedAuthProfileId;
}

export function registerFrontierEvidenceBinding(binding: FrontierEvidenceBinding): void {
  const scope = frontierEvidencePolicy.getStore();
  if (!scope) {
    throw new Error("frontier evidence policy is not active");
  }
  scope.bindings.push(binding);
}

export function readFrontierEvidenceBindings(): readonly FrontierEvidenceBinding[] {
  return frontierEvidencePolicy.getStore()?.bindings ?? [];
}

export function getFrontierEvidenceTaskDigest(): string | undefined {
  return frontierEvidencePolicy.getStore()?.taskDigest;
}

export function computeFrontierEvidenceDigest(
  key: string,
  domain:
    | "task"
    | "full-input"
    | "comparable-input"
    | "logical-call"
    | "prompt-cache-key"
    | "tool-schema",
  value: string,
): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`openclaw-frontier-${domain}-v1\0`)
    .update(value, "utf8")
    .digest("hex");
}

export function deriveFrontierEvidencePromptCacheKey(key: string, runNonce: string): string {
  if (!/^[a-f0-9]{64}$/u.test(runNonce)) {
    throw new Error("frontier evidence run nonce must be a 256-bit lowercase hex value");
  }
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update("openclaw-frontier-prompt-cache-key-v1\0")
    .update(runNonce, "utf8")
    .digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function parseFrontierEvidencePolicy(value: unknown): Omit<FrontierEvidencePolicy, "policySha256"> {
  const maxLogicalCalls = isRecord(value) ? value.maxLogicalCalls : undefined;
  if (
    !isRecord(value) ||
    value.version !== FRONTIER_EVIDENCE_POLICY_VERSION ||
    !isSha256(value.configSha256) ||
    typeof value.defaultAgentId !== "string" ||
    !value.defaultAgentId.trim() ||
    value.provider !== "openai" ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    value.api !== "openai-responses" ||
    value.baseUrl !== "https://api.openai.com/v1" ||
    value.runtime !== "openclaw" ||
    typeof value.authBindingId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.authBindingId) ||
    typeof value.contentDigestKey !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.contentDigestKey) ||
    value.credentialState !== "frozen_in_memory" ||
    value.credentialEnvName !== "OPENAI_API_KEY" ||
    value.fallbacks !== "disabled" ||
    value.proxy !== "disabled" ||
    value.tls !== "default" ||
    value.localService !== "disabled" ||
    !isRecord(value.endpoint) ||
    value.endpoint.origin !== "https://api.openai.com" ||
    value.endpoint.pathname !== "/v1/responses" ||
    value.endpoint.method !== "POST" ||
    value.endpoint.transport !== "responses-sdk" ||
    value.thinking !== "high" ||
    value.seed !== "absent" ||
    value.authoredRequestParams !== "absent" ||
    typeof maxLogicalCalls !== "number" ||
    !Number.isInteger(maxLogicalCalls) ||
    maxLogicalCalls < 1 ||
    maxLogicalCalls > 256 ||
    !isRecord(value.expectedReasoning) ||
    value.expectedReasoning.effort !== "high" ||
    value.expectedReasoning.summary !== "auto" ||
    Object.keys(value.expectedReasoning).length !== 2 ||
    !Array.isArray(value.expectedInclude) ||
    value.expectedInclude.length !== 1 ||
    value.expectedInclude[0] !== "reasoning.encrypted_content" ||
    !isRecord(value.expectedMetadata) ||
    value.expectedMetadata.source !== "openai_transport_turn_state" ||
    JSON.stringify(value.expectedMetadata.keys) !==
      JSON.stringify([
        "openclaw_session_id",
        "openclaw_transport",
        "openclaw_turn_attempt",
        "openclaw_turn_id",
      ]) ||
    value.expectedMetadata.valueClass !== "volatile_execution_metadata" ||
    value.expectedToolChoice !== "absent" ||
    value.expectedPromptCacheKey !== "session_boundary" ||
    value.expectedPromptCacheRetention !== "absent" ||
    value.expectedMaxRetries !== 2
  ) {
    throw new Error("frontier evidence policy schema is invalid");
  }
  return {
    version: FRONTIER_EVIDENCE_POLICY_VERSION,
    configSha256: value.configSha256,
    defaultAgentId: value.defaultAgentId,
    provider: "openai",
    model: value.model,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    runtime: "openclaw",
    authBindingId: value.authBindingId,
    contentDigestKey: value.contentDigestKey,
    credentialState: "frozen_in_memory",
    credentialEnvName: "OPENAI_API_KEY",
    fallbacks: "disabled",
    proxy: "disabled",
    tls: "default",
    localService: "disabled",
    endpoint: {
      origin: "https://api.openai.com",
      pathname: "/v1/responses",
      method: "POST",
      transport: "responses-sdk",
    },
    thinking: "high",
    seed: "absent",
    authoredRequestParams: "absent",
    maxLogicalCalls,
    expectedReasoning: { effort: "high", summary: "auto" },
    expectedInclude: ["reasoning.encrypted_content"],
    expectedMetadata: {
      source: "openai_transport_turn_state",
      keys: [
        "openclaw_session_id",
        "openclaw_transport",
        "openclaw_turn_attempt",
        "openclaw_turn_id",
      ],
      valueClass: "volatile_execution_metadata",
    },
    expectedToolChoice: "absent",
    expectedPromptCacheKey: "session_boundary",
    expectedPromptCacheRetention: "absent",
    expectedMaxRetries: 2,
  };
}

export async function readFrontierEvidencePolicyFile(params: {
  path: string;
  expectedSha256: string;
}): Promise<FrontierEvidencePolicy> {
  if (!isSha256(params.expectedSha256)) {
    throw new Error("frontier evidence policy SHA-256 is invalid");
  }
  const stat = await fs.stat(params.path);
  if (!stat.isFile()) {
    throw new Error("frontier evidence policy must be a regular file");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error("frontier evidence policy permissions must be 0600");
  }
  const raw = await fs.readFile(params.path);
  const actualSha256 = createHash("sha256").update(raw).digest("hex");
  if (actualSha256 !== params.expectedSha256) {
    throw new Error("frontier evidence policy SHA-256 mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error("frontier evidence policy JSON is invalid", { cause: error });
  }
  return {
    ...parseFrontierEvidencePolicy(parsed),
    policySha256: actualSha256,
  };
}
