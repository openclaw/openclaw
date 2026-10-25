import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";

const resolveToken = vi.hoisted(() => vi.fn());
const authenticate = vi.hoisted(() => vi.fn());
const guardFetch = vi.hoisted(() => vi.fn());

vi.mock("./auth.js", () => ({
  resolveFirstGithubToken: resolveToken,
}));

vi.mock("./runtime-auth.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://example.test",
  resolveCopilotRuntimeAuth: authenticate,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: guardFetch,
}));

import { cancelTrackedTextResponse } from "../test-support/streaming-error-response.js";
import { githubCopilotMemoryEmbeddingProviderAdapter as adapter } from "./embeddings.js";

afterAll(() => {
  vi.doUnmock("./auth.js");
  vi.doUnmock("./runtime-auth.js");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

const TEST_BASE_URL = "https://example.test";

function mockModels(
  models: Array<{ id: string; supported_endpoints?: string[] }> = [
    { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
  ],
) {
  mockDiscoveryResponse(Response.json({ data: models }));
}

function mockDiscoveryResponse(response: Response) {
  guardFetch.mockImplementationOnce(async () => ({
    response,
    release: vi.fn(async () => {}),
  }));
}

const defaultCreateOptions = { config: {}, agentDir: "/tmp/test-agent", model: "" };

function create(options: Partial<Parameters<typeof adapter.create>[0]> = {}) {
  return adapter.create({ ...defaultCreateOptions, ...options });
}

function configured<T>(settings: T) {
  return {
    models: {
      providers: { "github-copilot": { baseUrl: TEST_BASE_URL, models: [], ...settings } },
    },
  };
}

describe("githubCopilotMemoryEmbeddingProviderAdapter", () => {
  beforeEach(() => {
    resolveToken.mockResolvedValue({
      githubToken: "test-token-placeholder",
    });
    authenticate.mockResolvedValue({
      apiKey: "test-token-placeholder",
      baseUrl: TEST_BASE_URL,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resolveToken.mockReset();
    authenticate.mockReset();
    guardFetch.mockReset();
  });

  it("preserves the selected enterprise OAuth account's domain for embedding auth", async () => {
    resolveToken.mockResolvedValueOnce({
      githubToken: "durable-github-token",
      githubDomain: "acme.ghe.com",
    });
    mockModels();

    await create({
      config: configured({
        baseUrl: "https://api.githubcopilot.com",
        params: { githubDomain: "other.ghe.com" },
      }),
    });

    expect(authenticate.mock.calls[0]?.[0]).toMatchObject({
      githubToken: "durable-github-token",
      githubDomain: "acme.ghe.com",
    });
  });

  it.each(["model discovery", "embeddings"] as const)("bounds %s error bodies", async (stage) => {
    const status = stage === "model discovery" ? 503 : 429;
    const tracked = cancelTrackedTextResponse(`${`${stage} denied `.repeat(1024)}tail`, {
      status,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    if (stage === "model discovery") {
      mockDiscoveryResponse(tracked.response);
    } else {
      mockModels();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => tracked.response),
      );
    }
    const request = async () => {
      const result = await create();
      await result.provider?.embed("hello", { inputType: "query" });
    };
    const caught = await request().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error("Expected bounded provider error");
    }
    expect(caught.message).toContain(`GitHub Copilot ${stage} HTTP ${status}`);
    expect(caught.message).toContain(`${stage} denied`);
    expect(caught.message).not.toContain("tail");
    expect(caught.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("strips the provider prefix from a user-selected model", async () => {
    const options = {
      ...defaultCreateOptions,
      model: "github-copilot/text-embedding-3-small",
    };
    expect(adapter.normalizeModel?.(options)).toBe("text-embedding-3-small");
    expect(resolveToken).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(guardFetch).not.toHaveBeenCalled();
    mockModels();

    const result = await adapter.create(options);

    expect(result.provider?.model).toBe("text-embedding-3-small");
  });

  it.each(["gpt-4o", "github-copilot/github-copilot/text-embedding-3-small"])(
    "rejects the unavailable explicit model %s",
    async (model) => {
      mockModels();

      await expect(
        create({
          model:
            adapter.normalizeModel?.({
              ...defaultCreateOptions,
              model,
            }) ?? model,
        }),
      ).rejects.toThrow(`GitHub Copilot embedding model "${model}" is not available`);
    },
  );

  it("throws when discovery finds no embedding models", async () => {
    mockModels([{ id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] }]);

    await expect(create()).rejects.toThrow("No embedding models available from GitHub Copilot");
  });

  it.each(["discovery", "embeddings"] as const)(
    "redacts encoded request-header credentials from %s failures",
    async (stage) => {
      const body = "upstream rejected synthetic%2Bcredential%3Avalue; quota exhausted";
      if (stage === "discovery") {
        mockDiscoveryResponse(new Response(body, { status: 403 }));
      } else {
        mockModels([{ id: "text-embedding-3-small" }]);
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response(body, { status: 403 })),
        );
      }
      const request = async () => {
        const result = await create({
          remote: { headers: { "X-Proxy-Token": "synthetic+credential:value" } },
        });
        if (stage === "embeddings") {
          await result.provider?.embed("hello", { inputType: "query" });
        }
      };

      await expect(request()).rejects.toThrow(
        `GitHub Copilot ${stage === "discovery" ? "model discovery" : "embeddings"} HTTP 403: upstream rejected ***; quota exhausted`,
      );
    },
  );

  it("does not forward a stored GitHub token to a custom remote endpoint", async () => {
    await expect(
      create({
        remote: { baseUrl: "https://proxy.example/v1" },
      }),
    ).rejects.toThrow("custom baseUrl requires an explicit memory.search.remote.apiKey");

    expect(resolveToken).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(guardFetch).not.toHaveBeenCalled();
  });

  it("does not exchange auth, discover models, or embed after an unavailable owner credential", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    resolveToken.mockRejectedValue(
      new Error(
        "providers.github-copilot.authProfiles.github-copilot:github.tokenRef is unresolved",
      ),
    );

    await expect(create()).rejects.toThrow("github-copilot:github.tokenRef is unresolved");

    expect(authenticate).not.toHaveBeenCalled();
    expect(guardFetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unresolved remote ref without falling back to another profile", async () => {
    await expect(
      create({
        remote: {
          apiKey: { source: "env", provider: "default", id: "MISSING_TEST_VALUE" },
        },
      } as never),
    ).rejects.toMatchObject({
      name: "UnresolvedSecretInputError",
      path: "memory.search.remote.apiKey",
    });
    expect(resolveToken).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("selects fallback for authentication and discovery errors, but not unrelated failures", () => {
    const cases: Array<[Error, boolean]> = [
      [new Error("Copilot user response missing endpoints.api"), true],
      [new Error("Unexpected response from GitHub Copilot user endpoint"), true],
      [new Error("github-copilot.model-discovery: malformed JSON response"), true],
      [new CopilotRuntimeAuthError({ reason: "timeout", timeoutMs: 30_000 }), true],
      [new Error("Network timeout"), false],
    ];
    for (const [error, expected] of cases) {
      expect(adapter.shouldContinueAutoSelection?.(error)).toBe(expected);
    }
  });
});
