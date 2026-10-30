import {
  omitNullRequestHeaders,
  type Context,
  type Model,
  type CacheRetention,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "../providers/openai-prompt-cache.js";
import { createModel } from "./openai-responses-prompt-observer.test-support.js";
import { buildOpenAIClientHeaders } from "./openai-transport-params.js";

const codexModel = createModel({
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
});

const context = { messages: [] } satisfies Context;

const proxyResponsesModel = createModel({
  provider: "openai-proxy",
  baseUrl: "https://responses-proxy.example.test/v1",
  compat: { sendSessionIdHeader: true },
});

const sessionHeaders = (model: Model, session: string, retention?: CacheRetention, headers = {}) =>
  buildOpenAIClientHeaders(model, context, headers, undefined, session, retention);

describe("buildOpenAIClientHeaders session_id affinity header", () => {
  it("clamps long internal session ids to the backend's 64-char cache key limit", () => {
    const longSessionId = `internal-session-effects-session-companion-${"a".repeat(50)}`;
    const headers = sessionHeaders(codexModel, longSessionId);
    const sessionHeader = headers.session_id;
    expect(Array.from(sessionHeader ?? "").length).toBeLessThanOrEqual(
      OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
    );
    expect(sessionHeader?.startsWith("internal-session-effects-session-companion-")).toBe(true);
  });

  it("omits generated Responses session headers when caching is disabled", () => {
    const headers = sessionHeaders(proxyResponsesModel, "proxy-session-123", "none");
    expect(headers.session_id).toBeUndefined();
  });

  it("preserves a mixed-case caller header with short retention", () => {
    const headers = sessionHeaders(proxyResponsesModel, "generated-affinity", "short", {
      SeSsIoN_Id: "caller-affinity",
    });
    expect(new Headers(omitNullRequestHeaders(headers)).get("session_id")).toBe("caller-affinity");
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === "session_id")).toHaveLength(
      1,
    );
  });
});
