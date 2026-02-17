import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { NextResponse } from "next/server";
import { readAuthProfileStore } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Resolve the openclaw.json config path. */
function resolveConfigPath(): string {
  const envPath = process.env.OPENCLAW_CONFIG;
  if (envPath) { return envPath; }
  return join(homedir(), ".openclaw", "openclaw.json");
}

/** Mask an API key for safe display: show first 4 + last 4 chars. */
function maskKey(key: string | undefined): string | undefined {
  if (!key) { return undefined; }
  const trimmed = key.trim();
  if (trimmed.length <= 8) { return trimmed.length > 0 ? `${trimmed.slice(0, 2)}…` : undefined; }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/** Deep-walk an object and mask any key named "apiKey", "token", "key", or "password". */
function redactSensitiveFields(obj: unknown): unknown {
  if (obj === null || obj === undefined) { return obj; }
  if (typeof obj !== "object") { return obj; }

  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveFields);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (
      (key === "apiKey" || key === "token" || key === "key" || key === "password" || key === "accessToken" || key === "refreshToken") &&
      typeof value === "string"
    ) {
      result[key] = maskKey(value);
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSensitiveFields(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Summarize auth profiles for UI display.
 * Returns a list of { profileId, provider, type, hasKey } objects.
 */
function summarizeAuthProfiles(): Array<{
  profileId: string;
  provider: string;
  type: string;
  hasKey: boolean;
}> {
  const store = readAuthProfileStore();
  return Object.entries(store.profiles).map(([profileId, profile]) => ({
    profileId,
    provider: profile.provider,
    type: profile.type,
    hasKey: Boolean(profile.key || profile.token || profile.accessToken),
  }));
}

export async function GET() {
  const configPath = resolveConfigPath();

  if (!existsSync(configPath)) {
    return NextResponse.json({
      exists: false,
      config: {},
      configPath,
      authProfiles: summarizeAuthProfiles(),
    });
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const redacted = redactSensitiveFields(config);

    return NextResponse.json({
      exists: true,
      config: redacted,
      configPath,
      authProfiles: summarizeAuthProfiles(),
    });
  } catch (err) {
    return NextResponse.json(
      { exists: true, error: `Failed to parse config: ${String(err)}`, configPath },
      { status: 500 },
    );
  }
}
