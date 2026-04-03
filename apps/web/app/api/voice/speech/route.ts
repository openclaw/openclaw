import { getCloudVoiceState } from "@/lib/dench-cloud-settings";
import {
  resolveElevenLabsVoiceId,
  synthesizeElevenLabsSpeech,
} from "@/lib/elevenlabs-voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SpeechRequestBody = {
  text?: unknown;
  voiceId?: unknown;
};

function buildUnavailableResponse(reason: string, status = 409) {
  return Response.json({ error: reason }, { status });
}

export async function POST(request: Request) {
  let body: SpeechRequestBody;
  try {
    body = (await request.json()) as SpeechRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return Response.json({ error: "Field 'text' is required." }, { status: 400 });
  }

  const voiceState = await getCloudVoiceState();
  if (voiceState.status === "no_key" || !voiceState.apiKey) {
    return buildUnavailableResponse("A valid Dench Cloud API key is required.");
  }
  if (voiceState.status === "invalid_key") {
    return buildUnavailableResponse(voiceState.validationError ?? "The Dench Cloud API key is invalid.");
  }
  if (!voiceState.elevenLabsEnabled) {
    return buildUnavailableResponse("Enable ElevenLabs in Integrations to use voice playback.");
  }

  try {
    const voiceId = await resolveElevenLabsVoiceId({
      gatewayUrl: voiceState.gatewayUrl,
      apiKey: voiceState.apiKey,
      requestedVoiceId: typeof body.voiceId === "string" ? body.voiceId : null,
      storedVoiceId: voiceState.selectedVoiceId,
    });

    if (!voiceId) {
      return buildUnavailableResponse("No ElevenLabs voice is available for playback.");
    }

    const { audio, contentType } = await synthesizeElevenLabsSpeech({
      gatewayUrl: voiceState.gatewayUrl,
      apiKey: voiceState.apiKey,
      text,
      voiceId,
    });

    return new Response(audio, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to generate speech." },
      { status: 502 },
    );
  }
}
