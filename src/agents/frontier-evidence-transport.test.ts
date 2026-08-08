import type { StreamFn } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { runWithFrontierEvidencePolicy } from "./frontier-evidence-policy.js";
import type { FrontierEvidencePolicy } from "./frontier-evidence-policy.js";
import { bindFrontierEvidenceTransport } from "./frontier-evidence-transport.js";

const profileId = "openai:matrix";

function policy(): FrontierEvidencePolicy {
  return {
    version: 1,
    policySha256: "a".repeat(64),
    configSha256: "b".repeat(64),
    defaultAgentId: "main",
    provider: "openai",
    model: "gpt-5.4",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    runtime: "openclaw",
    authBindingId: "c".repeat(32),
    contentDigestKey: "d".repeat(64),
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
    maxLogicalCalls: 64,
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

function attempt(): EmbeddedRunAttemptParams {
  return {
    provider: "openai",
    modelId: "gpt-5.4",
    model: {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
    agentHarnessId: "openclaw",
    requestedModelId: "gpt-5.4",
    fallbackActive: false,
    promptCacheKey: "session:0",
    sessionId: "session",
    workspaceDir: "/workspace/frontier-cell",
    runtimePlan: {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        harnessId: "openclaw",
      },
      observability: {
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        harnessId: "openclaw",
      },
      providerRuntimeHandle: {
        provider: "openai",
        modelId: "gpt-5.4",
      },
      auth: {
        modelRoute: {
          baseUrl: "https://api.openai.com/v1",
          requestTransportOverrides: "absent",
        },
      },
    },
  } as EmbeddedRunAttemptParams;
}

function bind(params?: {
  attempt?: EmbeddedRunAttemptParams;
  authProfileId?: string;
  effectiveExtraParams?: Record<string, unknown>;
}) {
  const streamFn = vi.fn() as unknown as StreamFn;
  return runWithFrontierEvidencePolicy(
    policy(),
    profileId,
    () =>
      bindFrontierEvidenceTransport({
        attempt: params?.attempt ?? attempt(),
        agentId: "main",
        authProfileId: params?.authProfileId ?? profileId,
        effectiveExtraParams: params?.effectiveExtraParams ?? {},
        streamFn,
      }),
    "e".repeat(64),
  );
}

describe("frontier evidence prepared-route guard", () => {
  it("binds a collector only after the complete route matches", () => {
    const result = bind();

    expect(result.binding?.collector.snapshot()).toMatchObject({
      valid: false,
      requestObservations: 0,
      fetchDispatchObservations: 0,
      mismatchCodes: ["observation_missing"],
    });
  });

  it("requires an exact current-turn timestamp envelope before the provider runs", () => {
    const bound = bind();
    const model = attempt().model;
    const options = { apiKey: "test", requestId: "provider-call-1" };

    expect(() =>
      bound.streamFn(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        options,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "comparable_input_binding_mismatch",
      }),
    );
    expect(() =>
      bound.streamFn(
        model,
        {
          messages: [
            {
              role: "user",
              content: "[Thu 2026-08-06 12:34 UTC] hello",
              timestamp: 1,
            },
          ],
        },
        options,
      ),
    ).not.toThrow();
  });

  it("requires the provider ledger call id before the provider runs", () => {
    const bound = bind();

    expect(() =>
      bound.streamFn(
        attempt().model,
        {
          messages: [
            {
              role: "user",
              content: "[Thu 2026-08-06 12:34 UTC] hello",
              timestamp: 1,
            },
          ],
        },
        { apiKey: "test" },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "comparable_input_binding_mismatch",
      }),
    );
  });

  it("rejects route or auth drift before the stream can run", () => {
    const changedAttempt = attempt();
    changedAttempt.modelId = "gpt-5.4-drifted";

    expect(() => bind({ attempt: changedAttempt })).toThrowError(
      expect.objectContaining({ code: "model_mismatch" }),
    );
    expect(() => bind({ authProfileId: "openai:other" })).toThrowError(
      expect.objectContaining({ code: "auth_profile_mismatch" }),
    );
  });

  it("rejects authored request controls at the prepared route boundary", () => {
    expect(() => bind({ effectiveExtraParams: { temperature: 0.2 } })).toThrowError(
      expect.objectContaining({ code: "request_authored_params_present" }),
    );
    expect(() => bind({ effectiveExtraParams: { seed: 42 } })).toThrowError(
      expect.objectContaining({ code: "request_seed_present" }),
    );
    expect(() => bind({ effectiveExtraParams: { toolChoice: "auto" } })).toThrowError(
      expect.objectContaining({ code: "request_authored_params_present" }),
    );
    expect(() => bind({ effectiveExtraParams: { maxRetries: 0 } })).toThrowError(
      expect.objectContaining({ code: "request_authored_params_present" }),
    );
  });
});
