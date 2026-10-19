// Real adapter/guarded transport, fixed external HTTP responses; no live API entitlement proof.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as authRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import {
  jsonResponse,
  mockPinnedHostnameResolution,
  requestUrl,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeGoogleResearch as executeParsedGoogleResearch,
  parseGoogleResearchInput,
  GoogleResearchError,
  type GoogleResearchContext,
  type GoogleResearchSnapshot,
} from "./research.js";

async function executeGoogleResearch(value: unknown, context: GoogleResearchContext) {
  return executeParsedGoogleResearch(parseGoogleResearchInput(value), context);
}

const profileId = "google:research";
const handle = { interactionId: "research-1", profileId };
const start = { action: "start", profileId, question: "Compare public transit options." };
const apiKeyAuth = {
  apiKey: "synthetic-google-key",
  profileId,
  source: "profile",
  mode: "api-key" as const,
};

function setupContext(): GoogleResearchContext {
  return {
    api: createTestPluginApi({
      runtime: createPluginRuntimeMock({
        agent: { resolveAgentDir: vi.fn(() => "/synthetic/agents/researcher") },
      }),
    }),
    agentId: "researcher",
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    prepareAccount: async () => {},
    recordReceipt: async () => {},
  };
}

function snapshot(
  value: Awaited<ReturnType<typeof executeGoogleResearch>>,
): GoogleResearchSnapshot {
  if (!("state" in value)) {
    throw new Error("Expected research snapshot.");
  }
  return value;
}

describe("Google managed research HTTP contract", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let context: GoogleResearchContext;
  let dnsFixture: ReturnType<typeof mockPinnedHostnameResolution>;

  beforeEach(() => {
    context = setupContext();
    dnsFixture = mockPinnedHostnameResolution();
    vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue(apiKeyAuth);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("describes storage, evidence, auth and unenforceable budgets without resolving credentials", async () => {
    await expect(executeGoogleResearch({ action: "describe" }, context)).resolves.toMatchObject({
      version: 1,
      kind: "managed-research",
      authModes: ["api-key"],
      citationEvidence: "provider-attributed",
      storageRequired: true,
      hardBudgets: { model: false, search: false, tokens: false },
      idempotentStart: false,
    });
    expect(authRuntime.resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serializes the documented agent request and resolves only the selected agent profile", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "research-1", status: "queued" }));
    const result = await executeGoogleResearch(
      { ...start, output: "A cited table", asOf: "2026-10-16" },
      context,
    );
    expect(result).toEqual({ state: "running", handle, citations: [], retryAfterMs: 5000 });
    expect(authRuntime.resolveApiKeyForProvider).toHaveBeenCalledExactlyOnceWith({
      provider: "google",
      profileId,
      lockedProfile: true,
      cfg: context.api.config,
      agentDir: "/synthetic/agents/researcher",
      signal: context.signal,
    });
    expect(context.api.runtime.agent.resolveAgentDir).toHaveBeenCalledWith(
      context.api.config,
      "researcher",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(requestUrl(url)).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      '{"agent":"deep-research-preview-04-2026","input":"Compare public transit options.\\n\\nRequested output:\\nA cited table\\n\\nResearch as of: 2026-10-16","background":true,"store":true,"tools":[{"type":"google_search"},{"type":"url_context"}],"agent_config":{"type":"deep-research","collaborative_planning":false}}',
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("x-goog-api-key")).toBe("synthetic-google-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
  });

  it.each([
    { ...apiKeyAuth, mode: "oauth" as const },
    { ...apiKeyAuth, profileId: "google:different" },
    { ...apiKeyAuth, profileId: undefined, source: "env" },
    { ...apiKeyAuth, apiKey: '{"token":"synthetic-oauth"}' },
  ])("rejects non-key or unpinned auth without HTTP ($mode / $profileId)", async (auth) => {
    vi.mocked(authRuntime.resolveApiKeyForProvider).mockResolvedValue(auth);
    await expect(executeGoogleResearch(start, context)).rejects.toMatchObject({ state: "blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates live authority after awaited credential resolution", async () => {
    let current = true;
    context.assertCurrent = () => {
      if (!current) {
        throw new Error("revoked");
      }
    };
    vi.mocked(authRuntime.resolveApiKeyForProvider).mockImplementation(async () => {
      await Promise.resolve();
      current = false;
      return apiKeyAuth;
    });
    await expect(executeGoogleResearch(start, context)).rejects.toMatchObject({ state: "blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates live authority after awaited DNS preparation at the actual HTTP effect", async () => {
    let current = true;
    context.assertCurrent = () => {
      if (!current) {
        throw new Error("revoked");
      }
    };
    // A mocked fetch normally skips DNS; opt this case into the real guard's lookup path.
    dnsFixture.mockRestore();
    const guardedFetch = ssrfRuntime.fetchWithSsrFGuard;
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation((options) =>
      guardedFetch({
        ...options,
        lookupFn: async () => {
          await Promise.resolve();
          current = false;
          return [{ address: "93.184.216.34", family: 4 }];
        },
      }),
    );
    await expect(executeGoogleResearch(start, context)).rejects.toMatchObject({ state: "blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts only model text and rebases UTF-8 citation bytes across blocks without inventing excerpts", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: "research-1",
        status: "completed",
        steps: [
          { type: "thought", content: [{ type: "text", text: "private thought" }] },
          { type: "google_search_result", content: [{ type: "text", text: "private tool trace" }] },
          {
            type: "model_output",
            content: [
              { type: "thought", summary: "private summary" },
              {
                type: "text",
                text: "Café ☕",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.com/a",
                    title: "A",
                    start_index: 6,
                    end_index: 9,
                  },
                  {
                    type: "url_citation",
                    url: "https://example.com/b",
                    start_index: 4,
                    end_index: 5,
                  },
                  {
                    type: "url_citation",
                    url: "javascript:alert(1)",
                    start_index: 0,
                    end_index: 3,
                  },
                ],
              },
              {
                type: "text",
                text: "東京",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.com/c",
                    start_index: 0,
                    end_index: 6,
                  },
                ],
              },
            ],
          },
        ],
        outputs: [{ type: "text", text: "obsolete field" }],
        usage: {
          total_input_tokens: 30,
          total_output_tokens: 10,
          total_thought_tokens: 5,
          total_tokens: 45,
        },
      }),
    );
    expect(await executeGoogleResearch({ action: "poll", handle }, context)).toEqual({
      state: "completed",
      handle,
      report: "Café ☕\n\n東京",
      citations: [
        { url: "https://example.com/a", title: "A", startByte: 6, endByte: 9 },
        { url: "https://example.com/b" },
        { url: "https://example.com/c", startByte: 11, endByte: 17 },
      ],
      usageTokens: 45,
    });
  });

  it.each([
    ["queued", "running"],
    ["in_progress", "running"],
    ["requires_action", "blocked"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["incomplete", "partial"],
    ["budget_exceeded", "partial"],
  ])("maps %s without treating accepted cancellation as terminal", async (status, state) => {
    const encodedHandle = { interactionId: "job/with?#", profileId };
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: encodedHandle.interactionId,
        status,
        steps: [{ type: "model_output", content: [{ type: "text", text: "Report." }] }],
        errors:
          status === "failed" ? [{ code: "provider-error", message: "private diagnostic" }] : [],
      }),
    );
    const result = await executeGoogleResearch(
      { action: "cancel", handle: encodedHandle },
      context,
    );
    expect(result).toMatchObject({ state, handle: encodedHandle, report: "Report." });
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
    if (status === "failed") {
      expect(result).toMatchObject({ reason: "Google research failed (1 provider diagnostics)." });
    }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(requestUrl(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions/job%2Fwith%3F%23/cancel",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("polls the encoded handle with GET and no body", async () => {
    const encodedHandle = { interactionId: "job/with?#", profileId };
    fetchMock.mockResolvedValue(
      jsonResponse({ id: encodedHandle.interactionId, status: "in_progress" }),
    );
    await executeGoogleResearch({ action: "poll", handle: encodedHandle }, context);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(requestUrl(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions/job%2Fwith%3F%23",
    );
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(authRuntime.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ profileId, lockedProfile: true }),
    );
  });

  it.each(["transport", "server", "malformed", "redirect"])(
    "never retries an indeterminate create (%s)",
    async (failure) => {
      if (failure === "transport") {
        fetchMock.mockRejectedValue(new Error("synthetic-google-key private transport trace"));
      } else if (failure === "server") {
        fetchMock.mockResolvedValue(jsonResponse({ message: "synthetic-google-key" }, 503));
      } else if (failure === "malformed") {
        fetchMock.mockResolvedValue(new Response("synthetic-google-key malformed JSON"));
      } else {
        fetchMock.mockResolvedValue(
          new Response(null, { status: 307, headers: { location: "https://example.com/leak" } }),
        );
      }
      const result = await executeGoogleResearch(start, context).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(GoogleResearchError);
      expect(result).toMatchObject({ state: "indeterminate", handle: undefined });
      expect(String(result)).not.toContain("synthetic-google-key");
      expect(result).not.toHaveProperty("cause");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves a created interaction handle when the returned state cannot be interpreted", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "research-1", status: "future-status" }));
    await expect(executeGoogleResearch(start, context)).rejects.toMatchObject({
      state: "indeterminate",
      handle,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates poll retry guidance without resubmission or changing the pinned handle", async () => {
    fetchMock.mockResolvedValue(
      new Response("private error", { status: 429, headers: { "retry-after": "12" } }),
    );
    await expect(executeGoogleResearch({ action: "poll", handle }, context)).rejects.toMatchObject({
      state: "indeterminate",
      handle,
      retryAfterMs: 12000,
      httpStatus: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not adopt a mismatched interaction on polling", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "different-job", status: "completed" }));
    await expect(executeGoogleResearch({ action: "poll", handle }, context)).rejects.toMatchObject({
      state: "indeterminate",
      handle,
    });
  });

  it("bounds JSON-escaped reports and canonicalized citations for durable storage", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: "research-1",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: "\u0000".repeat(256 * 1024),
                annotations: [
                  { type: "url_citation", url: "https://example.org/" + "é".repeat(1000) },
                  ...Array.from({ length: 100 }, (_, index) => ({
                    type: "url_citation",
                    url: `https://example.org/${index}/` + "a".repeat(1900),
                    title: "\u0000".repeat(1024),
                  })),
                ],
              },
            ],
          },
        ],
      }),
    );
    const result = snapshot(await executeGoogleResearch({ action: "poll", handle }, context));
    expect(result.state).toBe("partial");
    expect(result.reason).toContain("truncated");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result.citations))).toBeLessThanOrEqual(64 * 1024);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations.every((citation) => Buffer.byteLength(citation.url) <= 2048)).toBe(
      true,
    );
    // The maximum accepted feature request still fits beside the normalized result.
    expect(
      Buffer.byteLength(JSON.stringify({ request: "x".repeat(262_144), result })),
    ).toBeLessThan(1_048_576);
  });

  it("bounds report UTF-8 bytes and citation count, marking completed output partial", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: "research-1",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: "☕".repeat(100_000),
                annotations: Array.from({ length: 257 }, () => ({
                  type: "url_citation",
                  url: "https://example.com/a",
                  start_index: 0,
                  end_index: 3,
                })),
              },
            ],
          },
        ],
      }),
    );
    const result = snapshot(await executeGoogleResearch({ action: "poll", handle }, context));
    expect(result.state).toBe("partial");
    expect(Buffer.byteLength(result.report!)).toBe(262143);
    expect(result.report).not.toContain("�");
    expect(result.citations).toHaveLength(100);
    expect(result.reason).toContain("truncated");
  });

  it("rejects an oversized response while retaining the known poll handle", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: "research-1",
        status: "completed",
        steps: [
          { type: "model_output", content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }] },
        ],
      }),
    );
    await expect(executeGoogleResearch({ action: "poll", handle }, context)).rejects.toMatchObject({
      state: "indeterminate",
      handle,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...start, profileId: "" },
    { ...start, endpoint: "https://example.com" },
    { ...start, question: "x".repeat(65537) },
    { action: "poll", handle: { interactionId: "..", profileId } },
  ])("rejects invalid or unsupported input before auth/network", async (input) => {
    await expect(executeGoogleResearch(input, context)).rejects.toMatchObject({ state: "blocked" });
    expect(authRuntime.resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
