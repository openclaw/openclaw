import { NextRequest, NextResponse } from "next/server";
import {
  upsertAuthProfile,
  readConfig,
  writeConfig,
  applyAuthProfileConfig,
} from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Mapping from auth-method value (frontend) → { profileId, credentialProvider }
 * Must exactly match what the CLI's onboard-auth.credentials.ts does for each
 * provider. The gateway looks up credentials by profileId, so if they don't
 * match, the key won't be found.
 */
const AUTH_METHOD_MAP: Record<string, { profileId: string; provider: string }> = {
  // OpenAI
  "openai-api-key":              { profileId: "openai:default",              provider: "openai" },
  // Anthropic
  "apiKey":                      { profileId: "anthropic:default",           provider: "anthropic" },
  // Google
  "gemini-api-key":              { profileId: "google:default",              provider: "google" },
  // xAI
  "xai-api-key":                 { profileId: "xai:default",                provider: "xai" },
  // OpenRouter
  "openrouter-api-key":          { profileId: "openrouter:default",         provider: "openrouter" },
  // Vercel AI Gateway
  "ai-gateway-api-key":          { profileId: "vercel-ai-gateway:default",  provider: "vercel-ai-gateway" },
  // Moonshot
  "moonshot-api-key":            { profileId: "moonshot:default",           provider: "moonshot" },
  "moonshot-api-key-cn":         { profileId: "moonshot:default",           provider: "moonshot" },
  // Kimi Coding
  "kimi-code-api-key":           { profileId: "kimi-coding:default",        provider: "kimi-coding" },
  // Together
  "together-api-key":            { profileId: "together:default",           provider: "together" },
  // Hugging Face
  "huggingface-api-key":         { profileId: "huggingface:default",        provider: "huggingface" },
  // Venice
  "venice-api-key":              { profileId: "venice:default",             provider: "venice" },
  // LiteLLM
  "litellm-api-key":             { profileId: "litellm:default",            provider: "litellm" },
  // Synthetic
  "synthetic-api-key":           { profileId: "synthetic:default",          provider: "synthetic" },
  // Custom
  "custom-api-key":              { profileId: "custom:default",             provider: "custom" },
};

/**
 * POST /api/settings/auth
 *
 * Body: { provider: string, authMethod: string, apiKey: string }
 *
 * 1. Writes the API key to credentials.json (AuthProfileStore) – same as CLI.
 * 2. Links the auth profile in openclaw.json – same as CLI.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { authMethod, apiKey } = body as {
      provider?: string;
      authMethod?: string;
      apiKey?: string;
    };

    if (!authMethod) {
      return NextResponse.json(
        { error: "authMethod is required" },
        { status: 400 },
      );
    }

    if (!apiKey || apiKey.trim().length === 0) {
      return NextResponse.json(
        { error: "apiKey is required" },
        { status: 400 },
      );
    }

    const mapping = AUTH_METHOD_MAP[authMethod];
    if (!mapping) {
      return NextResponse.json(
        { error: `Unknown auth method: ${authMethod}` },
        { status: 400 },
      );
    }

    const trimmedKey = apiKey.trim();

    // Step 1: Write credential to credentials.json (AuthProfileStore)
    upsertAuthProfile({
      profileId: mapping.profileId,
      credential: {
        type: "api_key",
        provider: mapping.provider,
        key: trimmedKey,
      },
    });

    // Step 2: Link the auth profile in openclaw.json
    const config = readConfig();
    const updatedConfig = applyAuthProfileConfig(config, {
      profileId: mapping.profileId,
      provider: mapping.provider,
      mode: "api_key",
    });
    writeConfig(updatedConfig);

    return NextResponse.json({
      ok: true,
      profileId: mapping.profileId,
      provider: mapping.provider,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to save auth config: ${String(err)}` },
      { status: 500 },
    );
  }
}
