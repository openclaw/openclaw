import { expect, it, vi } from "vitest";
import {
  configureProviderErrorRedactor,
  projectProviderError,
} from "../../packages/ai/src/utils/provider-error.js";
import { buildAssistantFailoverSignal } from "./embedded-agent-helpers/assistant-message-failures.js";
import { createRetryController } from "./embedded-agent-runner/run/failover-retry-controller.test-support.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  resolveFailoverClassificationFromError,
} from "./failover-error.js";
import { classifyFailoverSignal } from "./failover/classify.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

const sleeps = vi.hoisted(() => ({ wait: vi.fn(async () => {}) }));
vi.mock("../infra/backoff.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/backoff.js")>("../infra/backoff.js");
  return { ...actual, sleepWithAbort: sleeps.wait };
});

const context = { provider: "fixture", model: "selected-model" };
const quotaError = {
  status: 429,
  code: "RESOURCE_EXHAUSTED",
  quotaScope: "daily-model",
  message: "Provider quota exhausted",
};

it("retains a provider-declared daily model limit through failover normalization", () => {
  const normalized = coerceToFailoverError(quotaError, context);
  expect(normalized).toMatchObject({ reason: "rate_limit", quotaScope: "daily-model", ...context });
  const enriched = coerceToFailoverError(normalized, { rateLimitRetriesExhausted: 0 });
  expect(describeFailoverError(enriched)).toMatchObject({ quotaScope: "daily-model", ...context });
  expect(resolveFailoverClassificationFromError(enriched)).toEqual({
    kind: "reason",
    reason: "rate_limit",
    sameModelRetry: false,
  });
});

it.each([
  { name: "direct", raw: quotaError },
  { name: "cause wrapper", raw: { cause: quotaError } },
  { name: "error wrapper", raw: { error: quotaError } },
  {
    name: "unrelated diagnostics",
    raw: { ...quotaError, body: { diagnostic: "unrelated detail" } },
  },
  {
    name: "clipped structured diagnostics",
    raw: { ...quotaError, body: { diagnostic: "x".repeat(700) } },
  },
  {
    name: "coherent aliases",
    raw: {
      ...context,
      status: 429,
      statusCode: 429,
      code: "RESOURCE_EXHAUSTED",
      errorCode: "RESOURCE_EXHAUSTED",
      cause: { ...quotaError, ...context },
    },
  },
  {
    name: "coherent response wrapper",
    raw: { status: 429, response: { statusCode: 429, error: { ...quotaError, ...context } } },
  },
])(
  "carries producer-owned quota scope through projection and retry classification: $name",
  async ({ raw }) => {
    sleeps.wait.mockClear();
    const projected = projectProviderError(raw);
    expect(projected).toMatchObject({ quotaScope: "daily-model", errorCode: "RESOURCE_EXHAUSTED" });
    if ("body" in raw && raw.body.diagnostic.length > 500) {
      expect(() => JSON.parse(projected.errorBody ?? "")).toThrow();
    }
    const assistant = makeAssistantMessageFixture({ ...context, ...projected });
    const failure = classifyFailoverSignal(buildAssistantFailoverSignal(assistant));
    expect(failure).toEqual({ kind: "reason", reason: "rate_limit", sameModelRetry: false });
    if (failure?.kind !== "reason") {
      throw new Error("Missing classification");
    }
    const onRetry = vi.fn();
    const controller = createRetryController({
      runtime: { provider: "fixture", modelId: "selected-model" },
    });
    expect(
      await controller.maybeRetryTransient({
        reason: failure.reason,
        sameModelRetry: failure.sameModelRetry,
        onRetry,
      }),
    ).toBe(false);
    expect(onRetry).not.toHaveBeenCalled();
    expect(sleeps.wait).not.toHaveBeenCalled();
  },
);

it.each([
  { status: 429, code: "RESOURCE_EXHAUSTED" },
  { status: 429, code: "RESOURCE_EXHAUSTED", message: "Daily model quota exhausted" },
  { status: 429, code: "RESOURCE_EXHAUSTED", quotaScope: "daily-provider" },
  { status: 429, code: "RESOURCE_EXHAUSTED", quotaScope: "unknown" },
  { status: 503, code: "RESOURCE_EXHAUSTED", quotaScope: "daily-model" },
  { status: 429, code: "OTHER_CODE", quotaScope: "daily-model" },
  { status: 429, quotaScope: "daily-model", detail: { code: "RESOURCE_EXHAUSTED" } },
  { ...quotaError, status: 503, statusCode: 429 },
  { ...quotaError, statusCode: 503 },
  { ...quotaError, status: "429" },
  { ...quotaError, errorCode: "OTHER_CODE" },
  { ...quotaError, code: "OTHER_CODE", errorCode: "RESOURCE_EXHAUSTED" },
  { status: 429, code: "RESOURCE_EXHAUSTED", cause: { quotaScope: "daily-model" } },
])("does not promote incomplete or contradictory transport evidence: %j", (raw) => {
  const error = coerceToFailoverError(raw, context);
  expect(describeFailoverError(error).quotaScope).toBeUndefined();
  expect(projectProviderError(raw).quotaScope).toBeUndefined();
  expect(resolveFailoverClassificationFromError(error)).not.toMatchObject({
    sameModelRetry: false,
  });
});

it.each(["RESOURCE_EXHAUSTED", "OTHER_CODE", 8])(
  "vetoes a producer quota assertion for original status 402 (code=%s)",
  (code) => {
    const projected = projectProviderError({
      ...quotaError,
      status: 402,
      code,
      errorBody: JSON.stringify(quotaError),
    });
    expect(projected.quotaScope).toBeUndefined();
    const signal = buildAssistantFailoverSignal(
      makeAssistantMessageFixture({ ...context, ...projected }),
    );
    expect(signal).toMatchObject({ status: 402, quotaScope: undefined });
    expect(classifyFailoverSignal(signal)).not.toMatchObject({ sameModelRetry: false });
  },
);

it("does not combine quota scope with another error's status and code", () => {
  const raw = {
    status: 429,
    code: "RESOURCE_EXHAUSTED",
    cause: { quotaScope: "daily-model", status: 400 },
  };
  expect(describeFailoverError(coerceToFailoverError(raw, context)).quotaScope).toBeUndefined();
  expect(resolveFailoverClassificationFromError({ cause: quotaError })).toEqual({
    kind: "reason",
    reason: "rate_limit",
    sameModelRetry: false,
  });
});

it("keeps ordinary transport facts when diagnostics contain a body-only quota assertion", () => {
  const signal = buildAssistantFailoverSignal(
    makeAssistantMessageFixture({
      ...context,
      errorMessage: "429: Transport request failed",
      errorCode: "RESOURCE_EXHAUSTED",
      errorBody: JSON.stringify({ ...quotaError, ...context }),
    }),
  );
  expect(signal).toMatchObject({ status: 429, code: "RESOURCE_EXHAUSTED", quotaScope: undefined });
  expect(classifyFailoverSignal(signal)).not.toMatchObject({ sameModelRetry: false });
});

it.each([
  { status: 429, statusCode: 503, code: "RESOURCE_EXHAUSTED", cause: quotaError },
  { status: 429, code: "RESOURCE_EXHAUSTED", errorCode: "OTHER_CODE", cause: quotaError },
  { status: 402, code: "RESOURCE_EXHAUSTED", cause: quotaError },
  { status: "429", cause: quotaError },
  { provider: "outer-fixture", cause: { ...quotaError, provider: "inner-fixture" } },
  { model: "outer-model", cause: { ...quotaError, model: "inner-model" } },
  { status: 429, code: "RESOURCE_EXHAUSTED", cause: { statusCode: 503, cause: quotaError } },
  { status: 429, statusCode: 503, code: "RESOURCE_EXHAUSTED", error: quotaError },
  { status: 429, code: "RESOURCE_EXHAUSTED", response: { statusCode: 503, error: quotaError } },
])("rejects quota evidence with contradictory enclosing transport facts: %j", (raw) => {
  const projected = projectProviderError(raw);
  expect(projected.quotaScope).toBeUndefined();
  const assistant = makeAssistantMessageFixture({ ...context, ...projected });
  expect(classifyFailoverSignal(buildAssistantFailoverSignal(assistant))).not.toMatchObject({
    sameModelRetry: false,
  });
  expect(describeFailoverError(coerceToFailoverError(raw, context)).quotaScope).toBeUndefined();
});

it.each([
  { raw: quotaError, accepted: true },
  { raw: { status: 429, statusCode: 503, cause: quotaError }, accepted: false },
])(
  "carries the producer decision across diagnostic redaction (accepted=$accepted)",
  ({ raw, accepted }) => {
    const previous = configureProviderErrorRedactor(() => ({ ...quotaError }));
    try {
      const projected = projectProviderError(raw);
      const signal = buildAssistantFailoverSignal(
        makeAssistantMessageFixture({ ...context, ...projected }),
      );
      expect(projected.quotaScope).toBe(accepted ? "daily-model" : undefined);
      expect(classifyFailoverSignal(signal)).toEqual(
        accepted
          ? { kind: "reason", reason: "rate_limit", sameModelRetry: false }
          : { kind: "reason", reason: "rate_limit" },
      );
    } finally {
      configureProviderErrorRedactor(previous);
    }
  },
);

it("does not lose a conflicting producer alias beyond diagnostic key limits", () => {
  const raw = {
    ...quotaError,
    ...Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [`detail${index}`, "diagnostic"]),
    ),
    statusCode: 503,
  };
  const projected = projectProviderError(raw);
  expect(projected.quotaScope).toBeUndefined();
  const signal = buildAssistantFailoverSignal(
    makeAssistantMessageFixture({ ...context, ...projected }),
  );
  expect(classifyFailoverSignal(signal)).not.toMatchObject({ sameModelRetry: false });
});
