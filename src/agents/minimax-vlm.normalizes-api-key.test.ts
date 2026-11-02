import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "./minimax-vlm.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return { ...mod, fetchWithSsrFGuard: fetchWithSsrFGuardMock };
});

describe("minimaxUnderstandImage apiKey normalization", () => {
  function jsonResponse(payload: unknown) {
    return Response.json(payload);
  }

  function guarded(
    response = jsonResponse({ base_resp: { status_code: 0, status_msg: "ok" }, content: "ok" }),
  ) {
    return {
      response,
      release: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      finalUrl: "https://api.minimax.io/v1/coding_plan/vlm",
    };
  }

  function mockResponse(body: BodyInit, init: ResponseInit) {
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guarded(new Response(body, init)));
  }

  function unboundedResponse(chunk: Uint8Array, status: number, trace: string) {
    const cancel = vi.fn();
    const body = new ReadableStream({ pull: (controller) => controller.enqueue(chunk), cancel });
    mockResponse(body, { status, headers: { "Trace-Id": trace } });
    return cancel;
  }

  beforeEach(() => vi.stubEnv("MINIMAX_API_HOST", ""));

  afterEach(() => {
    vi.unstubAllEnvs();
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  function understandImage(overrides: Partial<Parameters<typeof minimaxUnderstandImage>[0]>) {
    return minimaxUnderstandImage({
      apiKey: "minimax-test-key",
      prompt: "hi",
      imageDataUrl: "data:image/png;base64,AAAA",
      ...overrides,
    });
  }

  async function requestOptions(input: Parameters<typeof understandImage>[0]) {
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guarded());
    await expect(understandImage(input)).resolves.toBe("ok");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    return fetchWithSsrFGuardMock.mock.calls[0]?.[0];
  }

  async function requestError(input: Parameters<typeof understandImage>[0] = {}) {
    const error = await understandImage({ modelBaseUrl: "https://api.minimax.io", ...input }).catch(
      (caught: unknown) => caught,
    );
    if (!(error instanceof Error)) {
      throw new Error("expected MiniMax VLM request to throw an Error");
    }
    return error.message;
  }

  it("strips embedded CR/LF before sending Authorization header", async () => {
    const opts = await requestOptions({
      apiKey: "minimax-test-\r\nkey",
      modelBaseUrl: "https://api.minimax.io",
    });
    expect(new Headers(opts?.init?.headers).get("Authorization")).toBe("Bearer minimax-test-key");
  });

  it("keeps trusted MINIMAX_API_HOST env fallback for VLM routing", async () => {
    process.env.MINIMAX_API_HOST = "https://api.minimaxi.com";
    const opts = await requestOptions({});
    expect(opts?.url).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });

  it.each([undefined, "https://["])(
    "keeps minimax-portal-cn on the CN host with configured host %s",
    async (modelBaseUrl) => {
      const opts = await requestOptions({
        provider: "minimax-portal-cn",
        ...(modelBaseUrl ? { modelBaseUrl } : {}),
      });
      expect(opts?.url).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
    },
  );

  it.each([
    ["api.minimax.io", undefined, false],
    ["localhost:8080", undefined, true],
    ["localhost:8080", false, false],
    ["custom-minimax.example.com", true, true],
    ["metadata.minimax.local", undefined, undefined],
    ["169.254.1.1", undefined, undefined],
  ] as const)(
    "SSRF policy for %s (private=%s, trusted=%s)",
    async (host, allowPrivateNetwork, trusted) => {
      const modelBaseUrl = `https://${host}`;
      const opts = await requestOptions({ modelBaseUrl, allowPrivateNetwork });
      if (trusted === undefined) {
        expect(opts?.policy).toBeUndefined();
      } else {
        expect(opts?.policy).toMatchObject({ hostnameAllowlist: [new URL(modelBaseUrl).hostname] });
        expect(opts?.policy?.allowedOrigins).toEqual(trusted ? [modelBaseUrl] : undefined);
        expect(opts?.policy?.allowPrivateNetwork).toBe(
          allowPrivateNetwork === true ? true : undefined,
        );
        expect(opts?.policy?.dangerouslyAllowPrivateNetwork).toBeUndefined();
      }
    },
  );

  it("carries model request proxy policy into the guarded fetch", async () => {
    const opts = await requestOptions({
      modelBaseUrl: "https://custom-minimax.example.com",
      request: { proxy: { mode: "explicit-proxy", url: "https://proxy.example.com" } },
    });
    expect(opts?.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "https://proxy.example.com",
    });
    expect(opts?.mode).toBeUndefined();
  });

  it("bounds large provider error response bodies", async () => {
    const cancel = unboundedResponse(
      new TextEncoder().encode(`${"x".repeat(9_000)}tail-marker`),
      500,
      "trace-123",
    );
    const message = await requestError();
    expect(message).toContain("MiniMax VLM request failed");
    expect(message).toContain("Trace-Id: trace-123");
    expect(message).not.toContain("tail-marker");
    expect(message.length).toBeLessThan(520);
    expect(cancel).toHaveBeenCalled();
  });

  it("bounds large successful response bodies before parsing JSON", async () => {
    const cancel = unboundedResponse(new Uint8Array(1024 * 1024), 200, "trace-success");
    expect(await requestError()).toBe(
      "MiniMax VLM response [Trace-Id=trace-success]: JSON response exceeds 16777216 bytes",
    );
    expect(cancel).toHaveBeenCalled();
  });

  it.each(["error body", "reason phrase", "Trace-Id", "application status message"])(
    "redacts the sent credential when reflected through %s",
    async (channel) => {
      const needle = "mm-short-7";
      fetchWithSsrFGuardMock.mockImplementationOnce(
        async (request: { init?: { headers?: HeadersInit } }) => {
          const authorization = new Headers(request.init?.headers).get("Authorization");
          expect(authorization).toBe(`Bearer ${needle}`);
          const reflected = `echoed ${authorization ?? ""}`;
          if (channel === "application status message") {
            return guarded(
              jsonResponse({ base_resp: { status_code: 1001, status_msg: reflected } }),
            );
          }
          return guarded(
            new Response(
              channel === "error body" ? reflected : channel === "Trace-Id" ? "bad" : "",
              {
                status: 401,
                statusText: channel === "reason phrase" ? reflected : "Unauthorized",
                ...(channel === "Trace-Id" ? { headers: { "Trace-Id": reflected } } : {}),
              },
            ),
          );
        },
      );

      const message = await requestError({ apiKey: needle });
      expect(message).not.toContain(needle);
      expect(message).toContain("***");
    },
  );
});

it("isMinimaxVlmModel only matches the canonical MiniMax VLM model id", () => {
  expect(isMinimaxVlmModel("minimax", "MiniMax-VL-01")).toBe(true);
  expect(isMinimaxVlmModel("minimax-cn", "MiniMax-VL-01")).toBe(true);
  expect(isMinimaxVlmModel("minimax-portal", "MiniMax-VL-01")).toBe(true);
  expect(isMinimaxVlmModel("minimax-portal-cn", "MiniMax-VL-01")).toBe(true);
  expect(isMinimaxVlmModel("minimax-portal", "custom-vision")).toBe(false);
  expect(isMinimaxVlmModel("openai", "MiniMax-VL-01")).toBe(false);
});
