import { beforeEach, expect, it, vi } from "vitest";

const resolveApiKeyForProviderMock = vi.hoisted(() => vi.fn());
const getCachedLiveProviderModelRowsMock = vi.hoisted(() => vi.fn());
const postJsonResponseMock = vi.hoisted(() => vi.fn());

// mock-isolation: credential resolution, the keyed model list and the upload are host-owned;
// tests control all three without I/O to prove the pre-upload eligibility contract.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));
vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-catalog-live-runtime")>()),
  getCachedLiveProviderModelRows: getCachedLiveProviderModelRowsMock,
}));
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonResponse: postJsonResponseMock,
}));

const { vercelAiGatewayMediaUnderstandingProvider } =
  await import("./media-understanding-provider.js");

beforeEach(() => {
  resolveApiKeyForProviderMock.mockReset();
  resolveApiKeyForProviderMock.mockResolvedValue({
    apiKey: "vck_test",
    mode: "api-key",
    source: "env: AI_GATEWAY_API_KEY",
  });
  getCachedLiveProviderModelRowsMock.mockReset();
  getCachedLiveProviderModelRowsMock.mockResolvedValue([
    { id: "anthropic/claude-opus-4.6", type: "language" },
    { id: "openai/gpt-transcribe", type: "transcription" },
  ]);
  postJsonResponseMock.mockReset();
  postJsonResponseMock.mockResolvedValue({ text: "hello" });
});

function transcribeWithContext(model?: string) {
  const transcribeAudioWithContext =
    vercelAiGatewayMediaUnderstandingProvider.transcribeAudioWithContext;
  if (!transcribeAudioWithContext) {
    throw new Error("expected Vercel AI Gateway context transcription");
  }
  return transcribeAudioWithContext({
    buffer: Buffer.from("audio-bytes"),
    fileName: "voice.ogg",
    mime: "audio/ogg",
    timeoutMs: 12_000,
    fetchFn: fetch,
    cfg: {},
    agentDir: "/tmp/agent",
    ...(model ? { model } : {}),
  });
}

it("uploads once the key's model list includes the transcription model", async () => {
  await expect(transcribeWithContext()).resolves.toEqual({
    ok: true,
    value: { text: "hello", model: "openai/gpt-transcribe" },
  });
  expect(getCachedLiveProviderModelRowsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      endpoint: "https://ai-gateway.vercel.sh/v1/models",
      apiKey: "vck_test",
    }),
  );
  expect(postJsonResponseMock).toHaveBeenCalledOnce();
  const [request] = postJsonResponseMock.mock.calls[0] ?? [];
  expect(request.url).toBe("https://ai-gateway.vercel.sh/v4/ai/transcription-model");
  expect(request.headers.get("authorization")).toBe("Bearer vck_test");
});

it("rejects scoped keys before upload when the model is not in their list", async () => {
  // Token Pass keys list only the language models they can call.
  getCachedLiveProviderModelRowsMock.mockResolvedValue([
    { id: "anthropic/claude-opus-4.6", type: "language" },
  ]);
  const result = await transcribeWithContext();
  expect(result.ok).toBe(false);
  expect(String(!result.ok && result.error)).toContain(
    'cannot use transcription model "openai/gpt-transcribe"',
  );
  expect(postJsonResponseMock).not.toHaveBeenCalled();
});

it("does not treat a same-named non-transcription model as eligible", async () => {
  getCachedLiveProviderModelRowsMock.mockResolvedValue([
    { id: "openai/gpt-transcribe", type: "language" },
  ]);
  expect((await transcribeWithContext()).ok).toBe(false);
  expect(postJsonResponseMock).not.toHaveBeenCalled();
});

it("rejects before upload when the model list cannot be read", async () => {
  getCachedLiveProviderModelRowsMock.mockRejectedValue(new Error("HTTP 401"));
  expect((await transcribeWithContext()).ok).toBe(false);
  expect(postJsonResponseMock).not.toHaveBeenCalled();
});

it("rejects before upload when no credential resolves", async () => {
  resolveApiKeyForProviderMock.mockRejectedValue(new Error("No API key found"));
  expect((await transcribeWithContext()).ok).toBe(false);
  expect(getCachedLiveProviderModelRowsMock).not.toHaveBeenCalled();
  expect(postJsonResponseMock).not.toHaveBeenCalled();
});

it("reports audio readiness from credential resolution without network calls", async () => {
  const isAudioConfigured = vercelAiGatewayMediaUnderstandingProvider.isAudioConfigured;
  if (!isAudioConfigured) {
    throw new Error("expected audio readiness check");
  }
  await expect(isAudioConfigured({ cfg: {} })).resolves.toBe(true);
  resolveApiKeyForProviderMock.mockRejectedValue(new Error("No API key found"));
  await expect(isAudioConfigured({ cfg: {} })).resolves.toBe(false);
  expect(getCachedLiveProviderModelRowsMock).not.toHaveBeenCalled();
});
