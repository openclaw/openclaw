import {
  getCloudSettingsState,
  saveApiKey,
  saveVoiceId,
  selectModel,
} from "@/lib/dench-cloud-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const state = await getCloudSettingsState();
    return Response.json(state);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to load cloud settings." },
      { status: 500 },
    );
  }
}

type PostBody = {
  action: "save_key" | "select_model" | "save_voice";
  apiKey?: string;
  stableId?: string;
  voiceId?: string | null;
};

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.action === "save_key") {
    if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
      return Response.json({ error: "Field 'apiKey' is required." }, { status: 400 });
    }
    try {
      const result = await saveApiKey(body.apiKey.trim());
      if (result.error) {
        return Response.json({ error: result.error, ...result }, { status: 409 });
      }
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to save API key." },
        { status: 500 },
      );
    }
  }

  if (body.action === "select_model") {
    if (typeof body.stableId !== "string" || !body.stableId.trim()) {
      return Response.json({ error: "Field 'stableId' is required." }, { status: 400 });
    }
    try {
      const result = await selectModel(body.stableId.trim());
      if (result.error) {
        return Response.json({ error: result.error, ...result }, { status: 409 });
      }
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to select model." },
        { status: 500 },
      );
    }
  }

  if (body.action === "save_voice") {
    try {
      const voiceId = typeof body.voiceId === "string"
        ? body.voiceId.trim() || null
        : body.voiceId === null || body.voiceId === undefined
          ? null
          : undefined;
      if (voiceId === undefined) {
        return Response.json({ error: "Field 'voiceId' must be a string or null." }, { status: 400 });
      }
      const result = await saveVoiceId(voiceId);
      if (result.error) {
        return Response.json({ error: result.error, ...result }, { status: 409 });
      }
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to save voice." },
        { status: 500 },
      );
    }
  }

  return Response.json(
    { error: "Unknown action. Use 'save_key', 'select_model', or 'save_voice'." },
    { status: 400 },
  );
}
