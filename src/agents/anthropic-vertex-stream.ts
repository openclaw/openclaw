/**
 * Vertex AI StreamFn — routes Claude requests through Google Vertex AI
 * while reusing the existing anthropic-messages pipeline end-to-end.
 *
 * Inspired by @sallyom's anthropic-vertex-stream.ts from PR #23985.
 * This version avoids a parallel streaming implementation by intercepting
 * at the HTTP layer (URL rewrite + auth swap via onPayload/headers),
 * keeping the diff minimal and reusing all existing SSE, tool use,
 * and thinking/reasoning support.
 *
 * @see https://github.com/openclaw/openclaw/pull/23985
 * @see https://github.com/openclaw/openclaw/issues/6937
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildVertexBaseUrl,
  getVertexAccessToken,
  resolveVertexProjectId,
  resolveVertexRegion,
} from "./anthropic-vertex-auth.js";

const log = createSubsystemLogger("anthropic-vertex-stream");

const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";

/**
 * Create a StreamFn that routes requests through the existing
 * `anthropic-messages` pipeline but redirects them to Google Vertex AI.
 *
 * How it works:
 * 1. The model's `baseUrl` is set to the Vertex streamRawPredict endpoint
 *    with a trailing `#`. The Anthropic SDK (used by pi-ai) appends
 *    `/v1/messages` via string concatenation, but the `#` causes it to
 *    land in the URL fragment, which `fetch()` strips per the WHATWG spec.
 * 2. The `Authorization: Bearer <gcp_token>` header is injected via
 *    `model.headers`, overriding the SDK's default `x-api-key`.
 * 3. `onPayload` removes the `model` field from the body (Vertex encodes
 *    it in the URL) and injects `anthropic_version`.
 *
 * This reuses 100% of pi-ai's Anthropic Messages streaming, parsing,
 * tool use, and thinking support with zero new dependencies.
 */
export function createAnthropicVertexStreamFn(params: {
  project: string;
  region: string;
  env?: NodeJS.ProcessEnv;
}): StreamFn {
  const { project, region } = params;
  const env = params.env ?? process.env;

  return (model, context, options) => {
    const vertexBaseUrl = buildVertexBaseUrl({
      project,
      region,
      model: model.id,
    });

    // Wrap in an async-start pattern: obtain the GCP token, then delegate.
    const run = async () => {
      const token = await getVertexAccessToken(env);

      const vertexModel = {
        ...model,
        baseUrl: vertexBaseUrl,
        headers: {
          ...model.headers,
          Authorization: `Bearer ${token}`,
        },
      } as typeof model;

      const originalOnPayload = options?.onPayload;

      return streamSimple(vertexModel, context, {
        ...options,
        onPayload: (payload, payloadModel) => {
          if (payload && typeof payload === "object") {
            const p = payload as Record<string, unknown>;
            // Vertex: model is in the URL, not the body.
            delete p.model;
            // Vertex requires anthropic_version in the body.
            p.anthropic_version = VERTEX_ANTHROPIC_VERSION;
          }
          return originalOnPayload?.(payload, payloadModel);
        },
      });
    };

    // streamSimple returns synchronously (an event stream object).
    // We need to start async work but return the stream immediately.
    // Use the same pattern as the ollama-stream: create the event stream,
    // run async logic, and pipe results through.
    //
    // However, streamSimple itself returns an event stream. We need to
    // proxy it. We'll return a Promise-like that resolves to the stream.
    // pi-ai's agent loop handles both sync and async StreamFn returns.
    return run() as unknown as ReturnType<StreamFn>;
  };
}

/**
 * Resolve Vertex configuration from environment and create the StreamFn.
 * Returns null if required config (project ID) is not available.
 */
export function resolveAnthropicVertexStreamFn(
  env: NodeJS.ProcessEnv = process.env,
): StreamFn | null {
  const project = resolveVertexProjectId(env);
  if (!project) {
    log.debug("anthropic-vertex: no project ID configured, skipping");
    return null;
  }

  const region = resolveVertexRegion(env);
  log.debug(`anthropic-vertex: project=${project} region=${region}`);

  return createAnthropicVertexStreamFn({ project, region, env });
}
