import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import {
  fetchWithProviderHttpGuard,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { decodeLiquidDecisionResult, supportsLiquidImageDimensions } from "./decision-codec.js";

type GuardOptions = Parameters<typeof fetchWithProviderHttpGuard>[0];
type LiquidDecisionTransport = Pick<GuardOptions, "url" | "policy" | "dispatcherPolicy"> & {
  headers: HeadersInit;
};

type LiquidDecisionExecution = Pick<
  DecisionProviderContextV2,
  "signal" | "deadlineMonotonicMs" | "isAdmissible"
> & {
  body: string;
  capabilities: Parameters<typeof decodeLiquidDecisionResult>[2];
  getImageMetadata: (buffer: Buffer) => Promise<{ width: number; height: number } | null>;
  prepareTransport: () => LiquidDecisionTransport;
};

export async function executeLiquidDecision(
  batch: DecisionBatchV2,
  execution: LiquidDecisionExecution,
): Promise<ProviderDecisionOutcomeV2> {
  let release: (() => Promise<void>) | undefined;
  let admissionError: { error: unknown } | undefined;
  const assertActive = () => {
    execution.signal.throwIfAborted();
    let admitted: boolean;
    try {
      admitted = execution.isAdmissible();
    } catch (error) {
      admissionError = { error };
      throw error;
    }
    if (!admitted || performance.now() >= execution.deadlineMonotonicMs) {
      throw new Error("Liquid Decision is no longer admitted.");
    }
  };
  try {
    assertActive();
    if (batch.state.type === "image") {
      const metadata = await execution.getImageMetadata(
        Buffer.from(batch.state.dataUri.split(",", 2)[1]!, "base64"),
      );
      assertActive();
      if (!supportsLiquidImageDimensions(metadata)) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
    }
    const transport = execution.prepareTransport();
    assertActive();
    const guarded = await fetchWithProviderHttpGuard({
      url: transport.url,
      init: { method: "POST", headers: transport.headers, body: execution.body },
      signal: execution.signal,
      timeoutMs: execution.deadlineMonotonicMs - performance.now(),
      beforeRequest: assertActive,
      policy: transport.policy,
      dispatcherPolicy: transport.dispatcherPolicy,
      auditContext: "liquid-ai-decisions",
    });
    release = guarded.release;
    const response = guarded.response;
    if (!response.ok) {
      return {
        status: "unavailable",
        reason:
          response.status === 401 || response.status === 403
            ? "authentication"
            : response.status === 429
              ? "rate-limited"
              : [400, 413, 422].includes(response.status)
                ? "unsupported-input"
                : "transport",
      };
    }
    let value: unknown;
    try {
      value = await readProviderJsonResponse(response, "Liquid decisions", {
        maxBytes: 1_048_576,
        timeoutMs: Math.max(1, execution.deadlineMonotonicMs - performance.now()),
      });
    } catch {
      execution.signal.throwIfAborted();
      return { status: "unavailable", reason: "invalid-response" };
    }
    assertActive();
    return decodeLiquidDecisionResult(batch, value, execution.capabilities);
  } catch {
    execution.signal.throwIfAborted();
    if (admissionError) {
      throw admissionError.error;
    }
    return { status: "unavailable", reason: "transport" };
  } finally {
    await release?.();
  }
}
