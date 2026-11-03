import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  buildOpenRouterAudioTranscriptionBody,
  postJsonRequest,
  readProviderJsonObjectResponse,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import type { resolveClawRouterCapabilityHttpContext } from "./capability-offers.js";

export function validateClawRouterOpenRouterAudio(
  input: Pick<AudioTranscriptionRequest, "language" | "prompt" | "query">,
) {
  if (input.prompt?.trim()) {
    throw new Error("ClawRouter OpenRouter transcription does not support prompt hints");
  }
  if (input.language?.trim() && !/^[a-z]{2}$/.test(input.language.trim())) {
    throw new Error("ClawRouter OpenRouter requires a lowercase ISO-639-1 language");
  }
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (
      name !== "temperature" ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new Error("ClawRouter OpenRouter only supports a numeric temperature from 0 to 1");
    }
  }
}

export async function transcribeClawRouterOpenRouterAudio({
  request,
  http,
  model,
  url,
}: {
  request: AudioTranscriptionRequest;
  http: ReturnType<typeof resolveClawRouterCapabilityHttpContext>;
  model: string;
  url: string;
}) {
  const headers = new Headers(http.headers);
  headers.set("content-type", "application/json");
  const { response, release } = await postJsonRequest({
    url,
    headers,
    body: buildOpenRouterAudioTranscriptionBody({ ...request, model }),
    timeoutMs: request.timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
    fetchFn: request.fetchFn ?? fetch,
    allowPrivateNetwork: http.allowPrivateNetwork,
    dispatcherPolicy: http.dispatcherPolicy,
    auditContext: "clawrouter openrouter transcription",
  });
  try {
    const label = "ClawRouter OpenRouter transcription failed";
    await assertOkOrThrowHttpError(response, label, { requestHeaders: headers });
    if (response.status !== 200) throw new Error(label + ": incomplete response");
    const body = await readProviderJsonObjectResponse(response, label, {
      requestHeaders: headers,
      maxBytes: 1024 * 1024,
    });
    if (body.error !== undefined || (body.model !== undefined && body.model !== model)) {
      throw new Error(label + ": invalid response model or API error");
    }
    const text = requireTranscriptionText(body.text, label + ": missing transcript");
    if (
      (typeof body.text === "string" && body.text.length > 262144) ||
      /[\ud800-\udfff]/u.test(text)
    ) {
      throw new Error(label + ": invalid or oversized transcript");
    }
    return { text, model };
  } finally {
    await release();
  }
}
