import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { expectDefined } from "@openclaw/normalization-core";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  status: 401,
  boundaryCredentialAtCap: false,
  authorization: undefined as string | undefined,
  socketClosed: undefined as Promise<void> | undefined,
  releases: 0,
}));

async function waitForSocketClose(closed: Promise<void> | undefined): Promise<void> {
  await raceWithTimeout(expectDefined(closed, "Ollama request socket"), 2_000, () => {
    throw new Error("Ollama auth-failure response was not canceled before guarded release");
  });
}

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      const [params] = args;
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        policy: { allowPrivateNetwork: true },
        url: loopback.baseUrl,
      });
      return {
        ...guarded,
        release: async () => {
          try {
            if (guarded.response.status === 401 || guarded.response.status === 403) {
              await waitForSocketClose(loopback.socketClosed);
            }
          } finally {
            loopback.releases++;
            await guarded.release();
          }
        },
      };
    },
  };
});

const { createOllamaWebSearchProvider } = await import("../web-search-provider.js");

function createSearchTool(apiKey?: string) {
  return expectDefined(
    createOllamaWebSearchProvider().createTool({
      config: apiKey
        ? createModelProviderConfig({
            ollama: { baseUrl: "https://ollama.com", api: "ollama", models: [], apiKey },
          })
        : {},
    }),
    "Ollama web search tool",
  );
}

async function captureSearchError(tool: ReturnType<typeof createSearchTool>): Promise<Error> {
  const error = await tool
    .execute({ query: "latest openclaw release" })
    .catch((caught: unknown) => caught);
  if (!(error instanceof Error)) {
    throw new Error("expected Ollama web search error");
  }
  return error;
}

function withSearchServer(run: () => Promise<void>) {
  return withServer(
    (request, response) => {
      loopback.authorization = request.headers.authorization;
      loopback.socketClosed = new Promise<void>((resolve) => {
        request.socket.once("close", resolve);
      });
      const bearerCredential = loopback.authorization?.replace(/^\S+\s+/u, "") ?? "";
      const bodies: Record<number, unknown> = {
        200: { results: [{ title: "Success", url: "https://example.com", content: "control" }] },
        429: {
          error: "rate limit exceeded",
          authorizationEcho: loopback.authorization,
          bearerEcho: bearerCredential,
        },
      };
      let responseBody = JSON.stringify(bodies[loopback.status] ?? { error: "unauthorized" });
      if (loopback.status === 429 && loopback.boundaryCredentialAtCap) {
        const safeMarker = "bounded web-search diagnostic: ";
        responseBody = `${safeMarker}${"x".repeat(64_000 - safeMarker.length - (bearerCredential.length - 5))}${bearerCredential} trailing text`;
      }
      const completedResponse = loopback.status === 429 || loopback.status === 200;
      response.writeHead(loopback.status, {
        "content-length": String(
          completedResponse ? responseBody.length : responseBody.length + 1_024,
        ),
        "content-type": "application/json",
      });
      if (completedResponse) {
        response.end(responseBody);
      } else {
        response.write(responseBody);
      }
    },
    async (baseUrl) => {
      loopback.baseUrl = `${baseUrl}/api/web_search`;
      await run();
    },
  );
}

beforeEach(() => {
  loopback.status = 401;
  loopback.boundaryCredentialAtCap = false;
  loopback.authorization = undefined;
  loopback.socketClosed = undefined;
  loopback.releases = 0;
});

describe("ollama web search guarded fetch", () => {
  it.each([
    [401, "ollama signin"],
    [403, "unavailable"],
  ] as const)("cancels a stalled %i body before guarded release", (status, message) =>
    withSearchServer(async () => {
      loopback.status = status;
      const tool = createSearchTool();
      await expect(tool.execute({ query: "latest openclaw release" })).rejects.toMatchObject({
        status,
        statusCode: status,
        message: expect.stringContaining(message),
      });
      expect(loopback.releases).toBeGreaterThan(0);
    }),
  );

  it.each([false, true])("redacts a real 429 bearer echo, split at the cap=%s", (boundary) =>
    withSearchServer(async () => {
      loopback.status = 429;
      loopback.boundaryCredentialAtCap = boundary;
      const bearerCredential = "web-search-boundary-credential-secret";
      const authorization = `Bearer ${bearerCredential}`;
      const tool = createSearchTool(bearerCredential);
      const error = await captureSearchError(tool);

      expect(loopback.authorization).toBe(authorization);
      expect(error).toMatchObject({
        status: 429,
        statusCode: 429,
        message: expect.stringContaining("Ollama web search failed (429)"),
      });
      expect(error.message).toContain(
        boundary ? "bounded web-search diagnostic" : "rate limit exceeded",
      );
      expect(error.message).not.toContain(authorization);
      expect(error.message).not.toContain(bearerCredential);
      expect(error.message).not.toContain(bearerCredential.slice(0, -5));
      expect(loopback.releases).toBe(1);
      if (!boundary) {
        loopback.status = 200;
        const result = await tool.execute({ query: "latest openclaw release" });
        expect(result).toMatchObject({ provider: "ollama", count: 1 });
      }
    }),
  );
});
