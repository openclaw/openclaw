import { NextRequest, NextResponse } from "next/server";
import { upsertAuthProfile, applyAuthProfileConfig, readConfig, writeConfig } from "@/lib/settings";

/**
 * Normalize user API key/token input by trimming, removing shell syntax, and unquoting.
 */
function normalizeApiKeyInput(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return "";
  }

  // Handle shell-style assignments: export KEY="value" or KEY=value
  const assignmentMatch = trimmed.match(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
  const valuePart = assignmentMatch ? assignmentMatch[1].trim() : trimmed;

  const unquoted =
    valuePart.length >= 2 &&
    ((valuePart.startsWith('"') && valuePart.endsWith('"')) ||
      (valuePart.startsWith("'") && valuePart.endsWith("'")) ||
      (valuePart.startsWith("`") && valuePart.endsWith("`")))
      ? valuePart.slice(1, -1)
      : valuePart;

  const withoutSemicolon = unquoted.endsWith(";") ? unquoted.slice(0, -1) : unquoted;

  return withoutSemicolon.trim();
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/settings/token
 *
 * Body: { provider: string, authMethod: string, token: string, name?: string }
 *
 * Handles setup-token or paste-token flows (e.g., Anthropic `claude setup-token`).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { provider, authMethod, token, name } = body as {
      provider?: string;
      authMethod?: string;
      token?: string;
      name?: string;
    };

    if (!provider || !authMethod || !token) {
      return NextResponse.json(
        { error: "provider, authMethod, and token are required" },
        { status: 400 }
      );
    }

    const normalizedToken = normalizeApiKeyInput(token);
    if (!normalizedToken) {
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 400 }
      );
    }

    // Build profile ID (e.g., "anthropic:default" or "anthropic:work")
    const profileName = name?.trim() || "default";
    const profileId = `${provider}:${profileName}`;

    // Upsert to credentials.json
    upsertAuthProfile({
      profileId,
      credential: {
        type: "token",
        provider,
        token: normalizedToken,
      },
    });

    // Update openclaw.json to reference the profile
    const config = readConfig();
    const updatedConfig = applyAuthProfileConfig(config, {
      profileId,
      provider,
      mode: "token",
    });
    writeConfig(updatedConfig);

    return NextResponse.json({
      ok: true,
      profileId,
      provider,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to save token: ${String(err)}` },
      { status: 500 }
    );
  }
}
