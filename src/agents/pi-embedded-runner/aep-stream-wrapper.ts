import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

/**
 * AEP (Agentic Execution Protocol) header injection wrapper.
 *
 * Injects X-AEP-* governance headers into every outgoing LLM request when
 * AEP environment variables are set. This enables cost tracking, safety
 * enforcement, provenance, and governance when routed through an AEP proxy.
 *
 * Environment variables:
 *   AEP_ENTITY          — Organization/agent identity (e.g. "org:acme-corp")
 *   AEP_CLASSIFICATION  — Data classification level (e.g. "confidential")
 *   AEP_TRACE_ID        — Distributed trace ID for request correlation
 *   AEP_CONSENT         — Consent flags (e.g. "analytics=true,training=false")
 *   AEP_BUDGET          — Cost budget cap in USD (e.g. "10.00")
 *
 * When no AEP env vars are set, this wrapper is a no-op.
 *
 * @see https://github.com/aceteam-ai/aceteam-aep
 */
export function createAepHeadersWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const aepHeaders = resolveAepHeaders();
    if (!aepHeaders) {
      return underlying(model, context, options);
    }
    return underlying(model, context, {
      ...options,
      headers: {
        ...options?.headers,
        ...aepHeaders,
      },
    });
  };
}

function resolveAepHeaders(): Record<string, string> | null {
  const headers: Record<string, string> = {};

  const entity = process.env.AEP_ENTITY;
  const classification = process.env.AEP_CLASSIFICATION;
  const traceId = process.env.AEP_TRACE_ID;
  const consent = process.env.AEP_CONSENT;
  const budget = process.env.AEP_BUDGET;

  if (entity) {
    headers["X-AEP-Entity"] = entity;
  }
  if (classification) {
    headers["X-AEP-Classification"] = classification;
  }
  if (traceId) {
    headers["X-AEP-Trace-Id"] = traceId;
  }
  if (consent) {
    headers["X-AEP-Consent"] = consent;
  }
  if (budget) {
    headers["X-AEP-Budget"] = budget;
  }

  return Object.keys(headers).length > 0 ? headers : null;
}
