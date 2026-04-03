import { getCloudVoiceState } from "@/lib/dench-cloud-settings";
import { fetchElevenLabsVoices } from "@/lib/elevenlabs-voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildUnavailableResponse(reason: string, status = 409) {
  return Response.json({ error: reason }, { status });
}

export async function GET() {
  const voiceState = await getCloudVoiceState();
  if (voiceState.status === "no_key" || !voiceState.apiKey) {
    return buildUnavailableResponse("A valid Dench Cloud API key is required.");
  }
  if (voiceState.status === "invalid_key") {
    return buildUnavailableResponse(voiceState.validationError ?? "The Dench Cloud API key is invalid.");
  }

  try {
    const voices = await fetchElevenLabsVoices({
      gatewayUrl: voiceState.gatewayUrl,
      apiKey: voiceState.apiKey,
    });
    return Response.json({ voices });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to load ElevenLabs voices." },
      { status: 502 },
    );
  }
}
