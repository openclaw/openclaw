import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";
const PROFILE_CANDIDATES = [".profile", ".zprofile", ".zshrc", ".bashrc"] as const;

function readApiKeyFromProfile(): string | null {
  const home = os.homedir();
  for (const candidate of PROFILE_CANDIDATES) {
    const fullPath = path.join(home, candidate);
    try {
      const text = fs.readFileSync(fullPath, "utf-8");
      const match = text.match(
        /(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^\n"']+)["']?/,
      );
      const value = match?.[1]?.trim();
      if (value) {
        return value;
      }
    } catch {
      // Ignore profile read errors.
    }
  }
  return null;
}

export function resolveElevenLabsApiKeyWithProfileFallback(): string | null {
  const envValue = (process.env[ELEVENLABS_API_KEY_ENV] ?? "").trim();
  if (envValue) {
    return envValue;
  }
  return readApiKeyFromProfile();
}
