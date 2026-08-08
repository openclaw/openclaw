import type { OpenAIResponsesRequestParams } from "@openclaw/ai/internal/openai";
import type { Model } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { LookupFn } from "../infra/net/ssrf.js";
import type { FrontierEvidenceVolatileBindings } from "./frontier-evidence-comparable-input.js";
import type { FrontierEvidencePolicy } from "./frontier-evidence-policy.js";
import {
  assertFrontierEvidenceFetchDispatchPolicy,
  assertFrontierEvidenceRequest,
  assertFrontierEvidenceRetryPolicy,
  createFrontierEvidenceBinding,
  FrontierEvidenceMismatchError,
  observeFrontierEvidenceFetchDispatch,
} from "./frontier-evidence-transport-policy.js";

function assertFrontierEvidenceFetchDispatch(params: {
  binding: ReturnType<typeof createFrontierEvidenceBinding>;
  url: string;
  method: string;
}): void {
  assertFrontierEvidenceFetchDispatchPolicy(params);
  observeFrontierEvidenceFetchDispatch(params);
}

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

const model = {
  id: "gpt-5.4",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  maxTokens: 8192,
  contextWindow: 200_000,
} as Model;

const volatileBindings = {
  workspacePath: "/workspace/frontier-cell",
  sessionId: "frontier-session",
  currentTurnTimestampEnvelope: "[Thu 2026-08-06 12:34 UTC] ",
} satisfies FrontierEvidenceVolatileBindings;

function createBinding(promptCacheKey = "session:0") {
  return createFrontierEvidenceBinding(policy(), {
    promptCacheKey,
    taskDigest: "e".repeat(64),
  });
}

function beginLogicalCall(
  binding: ReturnType<typeof createBinding>,
  bindings: FrontierEvidenceVolatileBindings = volatileBindings,
): void {
  binding.beginLogicalCall(bindings, `provider-call-${String(nextLogicalCallId++)}`);
}

let nextLogicalCallId = 1;

function request(
  overrides: Partial<OpenAIResponsesRequestParams & Record<string, unknown>> = {},
  bindings: FrontierEvidenceVolatileBindings = volatileBindings,
): OpenAIResponsesRequestParams {
  return {
    model: "gpt-5.4",
    instructions: [
      `Working directory: ${bindings.workspacePath}`,
      `Runtime: sessionId=${bindings.sessionId}`,
    ].join("\n"),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${bindings.currentTurnTimestampEnvelope}hello`,
          },
        ],
      },
    ],
    stream: true,
    max_output_tokens: 8192,
    parallel_tool_calls: true,
    text: { verbosity: "low" },
    store: true,
    context_management: [{ type: "compaction", compact_threshold: 140_000 }],
    reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "session:0",
    metadata: {
      openclaw_session_id: "session",
      openclaw_transport: "stream",
      openclaw_turn_attempt: "1",
      openclaw_turn_id: "turn",
    },
    ...overrides,
  } as OpenAIResponsesRequestParams;
}

describe("frontier evidence policy guard", () => {
  it("records only redacted matched request and fetch-dispatch facts", () => {
    const binding = createBinding();
    beginLogicalCall(binding);

    assertFrontierEvidenceRequest({
      binding,
      model,
      request: request(),
      payloadVariant: "initial",
    });
    assertFrontierEvidenceFetchDispatch({
      binding,
      url: "https://api.openai.com/v1/responses",
      method: "POST",
    });

    expect(binding.collector.snapshot()).toEqual({
      version: 1,
      policySha256: "a".repeat(64),
      authBindingId: "c".repeat(32),
      credentialState: "frozen_in_memory",
      promptCacheKeyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      valid: true,
      logicalCalls: 1,
      requestObservations: 1,
      fetchDispatchObservations: 1,
      payloadVariants: ["initial"],
      callSequences: [
        {
          logicalCallOrdinal: 1,
          logicalCallBindingId: expect.stringMatching(/^[a-f0-9]{64}$/u),
          requestCount: 1,
          fetchDispatchCount: 1,
          payloadVariants: ["initial"],
          requests: [
            {
              requestOrdinal: 1,
              payloadVariant: "initial",
              fetchDispatchCount: 1,
              taskDigest: "e".repeat(64),
              fullInputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
              comparableInputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
              toolSchemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
          ],
        },
      ],
      mismatchCodes: [],
    });
    const serialized = JSON.stringify(binding.collector.snapshot());
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("/v1/responses");
    expect(serialized).not.toContain("session:0");
    expect(createBinding("session:1").collector.snapshot().promptCacheKeyDigest).not.toBe(
      binding.collector.snapshot().promptCacheKeyDigest,
    );
  });

  it("substitutes only declared volatile values in the final model-facing input", () => {
    const observe = (
      bindings: FrontierEvidenceVolatileBindings,
      requestValue: OpenAIResponsesRequestParams,
    ) => {
      const binding = createBinding();
      beginLogicalCall(binding, bindings);
      assertFrontierEvidenceRequest({
        binding,
        model,
        request: requestValue,
        payloadVariant: "initial",
      });
      assertFrontierEvidenceFetchDispatch({
        binding,
        url: "https://api.openai.com/v1/responses",
        method: "POST",
      });
      return binding.collector.snapshot().callSequences[0]!.requests[0]!;
    };
    const changedBindings = {
      workspacePath: "/workspace/other-cell",
      sessionId: "other-session",
      currentTurnTimestampEnvelope: "[Thu 2026-08-06 12:35 UTC] ",
    };
    const baseline = observe(volatileBindings, request());
    const volatileOnly = observe(changedBindings, request({}, changedBindings));
    const mutated = observe(
      volatileBindings,
      request({
        instructions: `${request().instructions}\nUnexpected instruction mutation`,
      }),
    );

    expect(volatileOnly.fullInputDigest).not.toBe(baseline.fullInputDigest);
    expect(volatileOnly.comparableInputDigest).toBe(baseline.comparableInputDigest);
    expect(mutated.comparableInputDigest).not.toBe(baseline.comparableInputDigest);
  });

  it("fails closed when declared volatile bindings are missing or placeholders preexist", () => {
    const missingBinding = createBinding();
    beginLogicalCall(missingBinding, {
      ...volatileBindings,
      workspacePath: "/workspace/not-in-request",
    });
    expect(() =>
      assertFrontierEvidenceRequest({
        binding: missingBinding,
        model,
        request: request(),
        payloadVariant: "initial",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<FrontierEvidenceMismatchError>>({
        code: "comparable_input_binding_mismatch",
      }),
    );

    const placeholderConflict = createBinding();
    beginLogicalCall(placeholderConflict);
    expect(() =>
      assertFrontierEvidenceRequest({
        binding: placeholderConflict,
        model,
        request: request({
          instructions: `${request().instructions}\n<FRONTIER_EVIDENCE_SESSION>`,
        }),
        payloadVariant: "initial",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<FrontierEvidenceMismatchError>>({
        code: "comparable_input_binding_mismatch",
      }),
    );
  });

  it("freezes the managed Responses SDK retry count", () => {
    const binding = createBinding();
    beginLogicalCall(binding);

    expect(() => assertFrontierEvidenceRetryPolicy(binding, undefined)).not.toThrow();
    expect(() => assertFrontierEvidenceRetryPolicy(binding, 0)).toThrowError(
      expect.objectContaining<Partial<FrontierEvidenceMismatchError>>({
        code: "request_control_mismatch",
      }),
    );
  });

  it.each([
    [{ seed: 42 }, "request_seed_present"],
    [{ temperature: 0.2 }, "request_authored_params_present"],
    [{ top_p: 0.8 }, "request_authored_params_present"],
    [{ service_tier: "priority" }, "request_authored_params_present"],
    [{ max_output_tokens: 1000 }, "request_authored_params_present"],
    [{ tool_choice: "auto" }, "request_control_mismatch"],
    [{ prompt_cache_key: "changed" }, "request_control_mismatch"],
    [{ prompt_cache_retention: "24h" }, "request_control_mismatch"],
    [{ reasoning: { effort: "high" } }, "request_control_mismatch"],
    [{ reasoning: { effort: "high", summary: "detailed" } }, "request_control_mismatch"],
    [{ include: undefined }, "request_control_mismatch"],
    [
      { include: ["reasoning.encrypted_content", "message.output_text.logprobs"] },
      "request_control_mismatch",
    ],
    [
      {
        metadata: {
          openclaw_session_id: "session",
          openclaw_transport: "stream",
          openclaw_turn_attempt: "1",
          openclaw_turn_id: "turn",
          authored: "present",
        },
      },
      "request_control_mismatch",
    ],
  ] as const)("rejects authored request controls before submission", (overrides, code) => {
    const binding = createBinding();
    beginLogicalCall(binding);

    expect(() =>
      assertFrontierEvidenceRequest({
        binding,
        model,
        request: request(overrides),
        payloadVariant: "initial",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<FrontierEvidenceMismatchError>>({
        code,
        message: `frontier evidence guard rejected request (${code})`,
      }),
    );
    expect(binding.collector.snapshot()).toMatchObject({
      valid: false,
      fetchDispatchObservations: 0,
      mismatchCodes: expect.arrayContaining([code, "observation_missing"]),
    });
  });

  it.each([
    ["https://api.openai.example/v1/responses", "POST", "endpoint_origin_mismatch"],
    ["https://api.openai.com/v1/chat/completions", "POST", "endpoint_path_mismatch"],
    ["https://api.openai.com/v1/responses?debug=1", "POST", "endpoint_query_present"],
    ["https://api.openai.com/v1/responses#debug", "POST", "endpoint_fragment_present"],
    ["https://api.openai.com/v1/responses", "GET", "http_method_mismatch"],
  ] as const)(
    "rejects noncanonical fetch dispatch without recording the URL",
    (url, method, code) => {
      const binding = createBinding();
      beginLogicalCall(binding);
      assertFrontierEvidenceRequest({
        binding,
        model,
        request: request(),
        payloadVariant: "initial",
      });

      expect(() => assertFrontierEvidenceFetchDispatch({ binding, url, method })).toThrowError(
        expect.objectContaining<Partial<FrontierEvidenceMismatchError>>({ code }),
      );
      const snapshot = binding.collector.snapshot();
      expect(snapshot).toMatchObject({ valid: false, mismatchCodes: [code] });
      expect(JSON.stringify(snapshot)).not.toContain(url);
    },
  );

  it("records repeated physical requests across multiple logical calls", () => {
    const binding = createBinding();
    const observe = () => {
      beginLogicalCall(binding);
      assertFrontierEvidenceRequest({
        binding,
        model,
        request: request(),
        payloadVariant: "initial",
      });
      assertFrontierEvidenceFetchDispatch({
        binding,
        url: "https://api.openai.com/v1/responses",
        method: "POST",
      });
    };

    observe();
    observe();
    expect(binding.collector.snapshot()).toMatchObject({
      valid: true,
      logicalCalls: 2,
      requestObservations: 2,
      fetchDispatchObservations: 2,
      callSequences: [
        {
          logicalCallOrdinal: 1,
          requestCount: 1,
          fetchDispatchCount: 1,
          payloadVariants: ["initial"],
          requests: [{ requestOrdinal: 1, payloadVariant: "initial", fetchDispatchCount: 1 }],
        },
        {
          logicalCallOrdinal: 2,
          requestCount: 1,
          fetchDispatchCount: 1,
          payloadVariants: ["initial"],
          requests: [{ requestOrdinal: 1, payloadVariant: "initial", fetchDispatchCount: 1 }],
        },
      ],
    });
  });

  it("requires a physical fetch dispatch for every request even when aggregate totals balance", () => {
    const binding = createBinding();
    beginLogicalCall(binding);
    assertFrontierEvidenceRequest({
      binding,
      model,
      request: request(),
      payloadVariant: "initial",
    });
    assertFrontierEvidenceFetchDispatch({
      binding,
      url: "https://api.openai.com/v1/responses",
      method: "POST",
    });
    assertFrontierEvidenceFetchDispatch({
      binding,
      url: "https://api.openai.com/v1/responses",
      method: "POST",
    });
    assertFrontierEvidenceRequest({
      binding,
      model,
      request: request(),
      payloadVariant: "encrypted-content-retry",
    });

    expect(binding.collector.snapshot()).toMatchObject({
      valid: false,
      requestObservations: 2,
      fetchDispatchObservations: 2,
      callSequences: [
        {
          logicalCallOrdinal: 1,
          requestCount: 2,
          fetchDispatchCount: 2,
          payloadVariants: ["initial", "encrypted-content-retry"],
          requests: [
            { requestOrdinal: 1, payloadVariant: "initial", fetchDispatchCount: 2 },
            {
              requestOrdinal: 2,
              payloadVariant: "encrypted-content-retry",
              fetchDispatchCount: 0,
            },
          ],
        },
      ],
      mismatchCodes: ["observation_missing"],
    });
  });

  it("accepts every guarded redirect hop for initial and recovery requests", () => {
    const binding = createBinding();
    beginLogicalCall(binding);
    for (const payloadVariant of ["initial", "encrypted-content-retry"] as const) {
      assertFrontierEvidenceRequest({
        binding,
        model,
        request: request(),
        payloadVariant,
      });
      for (let hop = 0; hop < 4; hop += 1) {
        assertFrontierEvidenceFetchDispatch({
          binding,
          url: "https://api.openai.com/v1/responses",
          method: "POST",
        });
      }
    }

    expect(binding.collector.snapshot()).toMatchObject({
      valid: true,
      requestObservations: 2,
      fetchDispatchObservations: 8,
      callSequences: [
        {
          requestCount: 2,
          fetchDispatchCount: 8,
          requests: [{ fetchDispatchCount: 4 }, { fetchDispatchCount: 4 }],
        },
      ],
      mismatchCodes: [],
    });
  });

  it("retains the full two-request retry and redirect observation envelope", () => {
    const binding = createBinding();
    beginLogicalCall(binding);
    for (const payloadVariant of ["initial", "encrypted-content-retry"] as const) {
      assertFrontierEvidenceRequest({
        binding,
        model,
        request: request(),
        payloadVariant,
      });
      for (let dispatch = 0; dispatch < 12; dispatch += 1) {
        assertFrontierEvidenceFetchDispatch({
          binding,
          url: "https://api.openai.com/v1/responses",
          method: "POST",
        });
      }
    }

    expect(binding.collector.snapshot()).toMatchObject({
      valid: true,
      requestObservations: 2,
      fetchDispatchObservations: 24,
      callSequences: [
        {
          requestCount: 2,
          fetchDispatchCount: 24,
          requests: [{ fetchDispatchCount: 12 }, { fetchDispatchCount: 12 }],
        },
      ],
      mismatchCodes: [],
    });
  });

  it("fails closed on a genuine redirect target drift without adding an attempt", async () => {
    const binding = createBinding();
    beginLogicalCall(binding);
    assertFrontierEvidenceRequest({
      binding,
      model,
      request: request(),
      payloadVariant: "initial",
    });
    let providerAttempts = 0;
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://edge.openai.example/v1/responses" },
      });
    });

    await expect(
      fetchWithSsrFGuard({
        url: "https://api.openai.com/v1/responses",
        init: { method: "POST" },
        fetchImpl,
        lookupFn: vi.fn(async () => [
          { address: "93.184.216.34", family: 4 as const },
        ]) as unknown as LookupFn,
        beforeFetchDispatch: ({ url, init }) =>
          assertFrontierEvidenceFetchDispatchPolicy({
            binding,
            url,
            method: init.method ?? "GET",
          }),
        observeFetchDispatch: ({ url, init }) =>
          observeFrontierEvidenceFetchDispatch({
            binding,
            url,
            method: init.method ?? "GET",
          }),
        onFetchDispatch: () => {
          providerAttempts += 1;
        },
      }),
    ).rejects.toMatchObject({ code: "endpoint_origin_mismatch" });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(providerAttempts).toBe(1);
    expect(binding.collector.snapshot()).toMatchObject({
      valid: false,
      requestObservations: 1,
      fetchDispatchObservations: 1,
      callSequences: [
        {
          requestCount: 1,
          fetchDispatchCount: 1,
          requests: [{ fetchDispatchCount: 1 }],
        },
      ],
      mismatchCodes: ["endpoint_origin_mismatch"],
    });
  });

  it("rejects recovery before the initial request has a physical fetch dispatch", () => {
    const binding = createBinding();
    beginLogicalCall(binding);
    assertFrontierEvidenceRequest({
      binding,
      model,
      request: request(),
      payloadVariant: "initial",
    });

    expect(() =>
      assertFrontierEvidenceRequest({
        binding,
        model,
        request: request(),
        payloadVariant: "encrypted-content-retry",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<FrontierEvidenceMismatchError>>({
        code: "observation_conflict",
      }),
    );
  });

  it("does not let a later call or fetch dispatch heal an incomplete prior request", () => {
    const binding = createBinding();
    beginLogicalCall(binding);
    assertFrontierEvidenceRequest({
      binding,
      model,
      request: request(),
      payloadVariant: "initial",
    });

    expect(() => beginLogicalCall(binding)).toThrowError(
      expect.objectContaining<Partial<FrontierEvidenceMismatchError>>({
        code: "observation_missing",
      }),
    );
    expect(binding.collector.snapshot()).toMatchObject({
      valid: false,
      logicalCalls: 1,
      requestObservations: 1,
      fetchDispatchObservations: 0,
      mismatchCodes: ["observation_missing"],
    });
  });

  it("rejects a second logical call when the first recorded no request", () => {
    const binding = createBinding();
    beginLogicalCall(binding);

    expect(() => beginLogicalCall(binding)).toThrowError(
      expect.objectContaining<Partial<FrontierEvidenceMismatchError>>({
        code: "observation_missing",
      }),
    );
    expect(binding.collector.snapshot()).toMatchObject({
      valid: false,
      logicalCalls: 1,
      requestObservations: 0,
      fetchDispatchObservations: 0,
      mismatchCodes: ["observation_missing"],
    });
  });

  it("rejects reuse of a provider ledger call id", () => {
    const binding = createBinding();
    binding.beginLogicalCall(volatileBindings, "provider-call-fixed");
    assertFrontierEvidenceRequest({
      binding,
      model,
      request: request(),
      payloadVariant: "initial",
    });
    assertFrontierEvidenceFetchDispatch({
      binding,
      url: "https://api.openai.com/v1/responses",
      method: "POST",
    });

    expect(() => binding.beginLogicalCall(volatileBindings, "provider-call-fixed")).toThrowError(
      expect.objectContaining<Partial<FrontierEvidenceMismatchError>>({
        code: "comparable_input_binding_mismatch",
      }),
    );
  });

  it.each([
    ["retry first", ["encrypted-content-retry"]],
    ["repeated recovery", ["initial", "encrypted-content-retry", "encrypted-content-retry"]],
  ] as const)("rejects invalid per-call payload order: %s", (_name, variants) => {
    const binding = createBinding();
    beginLogicalCall(binding);

    for (const [index, payloadVariant] of variants.entries()) {
      const submit = () =>
        assertFrontierEvidenceRequest({
          binding,
          model,
          request: request(),
          payloadVariant,
        });
      if (index === variants.length - 1) {
        expect(submit).toThrowError(
          expect.objectContaining<Partial<FrontierEvidenceMismatchError>>({
            code: "observation_conflict",
          }),
        );
      } else {
        submit();
        assertFrontierEvidenceFetchDispatch({
          binding,
          url: "https://api.openai.com/v1/responses",
          method: "POST",
        });
      }
    }
  });

  it("marks zero-observation snapshots invalid", () => {
    expect(createBinding().collector.snapshot()).toMatchObject({
      valid: false,
      logicalCalls: 0,
      mismatchCodes: ["observation_missing"],
    });
  });
});
