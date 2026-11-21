import type { PdfAnalysisRequest } from "openclaw/plugin-sdk/media-understanding";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiMediaUnderstandingProvider } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async () =>
    Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "ALPHA=37" }] }],
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function analyze(overrides: Partial<PdfAnalysisRequest> = {}) {
  return openaiMediaUnderstandingProvider.analyzePdf!({
    pdfs: [Buffer.from("%PDF-1.4 synthetic")],
    model: "gpt-4.1-mini",
    api: "openai-responses",
    apiKey: "synthetic-fixture-key",
    prompt: "Read the total.",
    ...overrides,
  });
}

function requestBody() {
  const request = fetchMock.mock.calls[0];
  expect(request).toBeDefined();
  if (!request || typeof request[1]?.body !== "string") {
    throw new Error("expected serialized JSON");
  }
  const input = request[0];
  return {
    url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    headers: new Headers(request[1].headers),
    body: JSON.parse(request[1].body),
  };
}

describe("OpenAI native PDF transport", () => {
  it.each([undefined, "https://api.openai.com", "https://api.openai.com/v1/"])(
    "serializes input_file only to the official Responses endpoint (%s)",
    async (baseUrl) => {
      expect(await analyze({ baseUrl, headers: { "X-Pdf-Fixture": "kept" } })).toEqual({
        text: "ALPHA=37",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const { url, headers, body } = requestBody();
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(headers.get("X-Pdf-Fixture")).toBe("kept");
      expect(body).toMatchObject({ model: "gpt-4.1-mini", max_output_tokens: 4096, store: false });
      expect(body.input[0].content).toEqual([
        {
          type: "input_file",
          filename: "document-1.pdf",
          file_data: "data:application/pdf;base64,JVBERi0xLjQgc3ludGhldGlj",
        },
        { type: "input_text", text: "Read the total." },
      ]);
    },
  );

  it.each([
    { baseUrl: "https://custom.example/v1" },
    { baseUrl: "https://chatgpt.com/backend-api/codex" },
    { baseUrl: "http://api.openai.com/v1" },
    { baseUrl: "https://api.openai.com/v1?redirect=other" },
    { api: "openai-chatgpt-responses" },
    { api: "openai-completions" },
  ])("declines unsupported routes before any HTTP request (%j)", async (overrides) => {
    expect(await analyze(overrides)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [50_000_000],
    [25_000_000, 25_000_001],
    [9_000_000, 9_000_000, 9_000_000, 9_000_000, 9_000_000, 9_000_000],
  ])("keeps over-limit documents off the native request (%j)", async (...sizes) => {
    expect(await analyze({ pdfs: sizes.map((size) => Buffer.alloc(size)) })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the exact combined 50 MB boundary without persistent file uploads", async () => {
    expect(await analyze({ pdfs: [Buffer.alloc(25_000_000), Buffer.alloc(25_000_000)] })).toEqual({
      text: "ALPHA=37",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestBody().body.input[0].content.map((part: { type: string }) => part.type)).toEqual([
      "input_file",
      "input_file",
      "input_text",
    ]);
  });

  it("does not submit an already cancelled native request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(analyze({ signal: controller.signal })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts provider failures and does not retry the paid submission", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad synthetic-fixture-key", { status: 401 }));
    await expect(analyze()).rejects.not.toThrow("synthetic-fixture-key");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
