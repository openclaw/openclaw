import { getCloudVoiceState } from "@/lib/dench-cloud-settings";
import { transcribeElevenLabsAudio } from "@/lib/elevenlabs-voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function buildUnavailableResponse(reason: string, status = 409) {
  return Response.json({ error: reason }, { status });
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid form data." }, { status: 400 });
  }

  const uploaded = formData.get("file");
  if (!(uploaded instanceof Blob)) {
    return Response.json({ error: "Field 'file' is required." }, { status: 400 });
  }

  const voiceState = await getCloudVoiceState();
  if (voiceState.status === "no_key" || !voiceState.apiKey) {
    return buildUnavailableResponse("A valid Dench Cloud API key is required.");
  }
  if (voiceState.status === "invalid_key") {
    return buildUnavailableResponse(voiceState.validationError ?? "The Dench Cloud API key is invalid.");
  }
  if (!voiceState.elevenLabsEnabled) {
    return buildUnavailableResponse("Enable ElevenLabs in Integrations to use server-side transcription.");
  }

  const file = uploaded instanceof File
    ? uploaded
    : new File([uploaded], "recording.webm", { type: uploaded.type || "audio/webm" });

  try {
    const transcript = await transcribeElevenLabsAudio({
      gatewayUrl: voiceState.gatewayUrl,
      apiKey: voiceState.apiKey,
      file,
    });
    return Response.json(transcript);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to transcribe audio." },
      { status: 502 },
    );
  }
}
