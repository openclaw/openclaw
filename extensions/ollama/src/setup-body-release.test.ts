// Ollama setup failed-response body release regression tests.
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { jsonResponse, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkOllamaCloudAuth, promptAndConfigureOllama } from "./setup.js";

const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => {}));

const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: { url: string; init?: RequestInit; signal?: AbortSignal }) => ({
    response: await globalThis.fetch(params.url, {
      ...params.init,
      ...(params.signal ? { signal: params.signal } : {}),
    }),
    finalUrl: params.url,
    release: async () => {},
  })),
);

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  return {
    ...actual,
    upsertAuthProfileWithLock,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: Parameters<typeof actual.fetchWithSsrFGuard>) =>
      fetchWithSsrFGuardMock(...args),
  };
});

function responseWithCancelSpy(status: number) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":"boom"}\n'));
      // Body stays open until cancelled, like a slow or stalled peer.
    },
    cancel(reason) {
      cancel(reason);
    },
  });
  return { response: new Response(body, { status }), cancel };
}

describe("failed response body release", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("cancels the /api/me body when the auth probe is not OK", async () => {
    const { response, cancel } = responseWithCancelSpy(500);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      finalUrl: "https://ollama.com/api/me",
      release: async () => {},
    });

    await expect(checkOllamaCloudAuth("https://ollama.com")).resolves.toEqual({
      signedIn: false,
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels the /api/me body after a successful auth probe", async () => {
    const { response, cancel } = responseWithCancelSpy(200);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      finalUrl: "https://ollama.com/api/me",
      release: async () => {},
    });

    await expect(checkOllamaCloudAuth("https://ollama.com")).resolves.toEqual({
      signedIn: true,
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels the /api/pull error body", async () => {
    const { response, cancel } = responseWithCancelSpy(500);
    const progress = { update: vi.fn(), stop: vi.fn() };
    const prompter = {
      select: vi.fn().mockResolvedValueOnce("local-only"),
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      confirm: vi.fn().mockResolvedValueOnce(true),
      progress: vi.fn(() => progress),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "llama3:8b" }] });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({ capabilities: ["generate"] });
      }
      if (url.endsWith("/api/pull")) {
        return response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(promptAndConfigureOllama({ cfg: {}, prompter })).rejects.toThrow(
      /Failed to download/,
    );
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels the /api/show error body during the tools scan", async () => {
    const { response, cancel } = responseWithCancelSpy(500);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "llama3:8b" }] });
      }
      if (url.endsWith("/api/show")) {
        return response;
      }
      if (url.endsWith("/api/me")) {
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const prompter = {
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      select: vi.fn().mockResolvedValueOnce("local-only"),
      confirm: vi.fn().mockResolvedValueOnce(false),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    // The tools scan fails open per model; the error body must still be released.
    await promptAndConfigureOllama({ cfg: {}, prompter });
    expect(cancel).toHaveBeenCalled();
  });
});
