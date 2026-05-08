import { afterEach, describe, expect, it, vi } from "vitest";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

describe("lmstudio embedding provider", () => {
  const parseJsonRequestBody = (init: RequestInit | undefined): unknown => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected request body to be a JSON string");
    }
    return JSON.parse(init.body) as unknown;
  };

  const createModelLoadFetchMock = () =>
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/api/v1/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              {
                type: "embedding",
                key: "text-embedding-nomic-embed-text-v1.5",
                max_context_length: 8192,
                loaded_instances: [],
              },
            ],
          }),
        };
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "loaded" }),
          text: async () => "",
          requestInit: init,
        };
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });

  const findModelLoadCall = (fetchMock: ReturnType<typeof createModelLoadFetchMock>) =>
    fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/models/load"));

  async function createProviderAndGetLoadBody(
    ttlSeconds?: unknown,
  ): Promise<Record<string, unknown>> {
    const fetchMock = createModelLoadFetchMock();
    fetchWithSsrFGuardMock.mockImplementation(
      async (params: { url: string; init?: RequestInit }) => ({
        response: await fetchMock(params.url, params.init),
        release: async () => {},
      }),
    );

    await createLmstudioEmbeddingProvider({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234/v1",
              ...(ttlSeconds !== undefined ? { params: { ttlSeconds } } : {}),
            },
          },
        },
      },
      model: "text-embedding-nomic-embed-text-v1.5",
    } as never);

    const loadCall = findModelLoadCall(fetchMock);
    expect(loadCall).toBeDefined();
    return parseJsonRequestBody(loadCall?.[1] as RequestInit) as Record<string, unknown>;
  }

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("passes configured idle TTL to native model load body", async () => {
    await expect(createProviderAndGetLoadBody(120)).resolves.toMatchObject({
      ttl: 120,
    });
  });

  it("omits idle TTL from native model load body when ttlSeconds is unset", async () => {
    await expect(createProviderAndGetLoadBody()).resolves.not.toHaveProperty("ttl");
  });

  it.each([0, Number.NaN, "300", -1])(
    "omits idle TTL from native model load body when ttlSeconds is invalid: %s",
    async (ttlSeconds) => {
      await expect(createProviderAndGetLoadBody(ttlSeconds)).resolves.not.toHaveProperty("ttl");
    },
  );
});
