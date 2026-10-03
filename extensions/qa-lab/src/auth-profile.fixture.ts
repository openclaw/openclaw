import type { AuthProfileCredential } from "openclaw/plugin-sdk/agent-runtime";
import { readQaAuthProfiles, writeQaAuthProfiles } from "./providers/shared/auth-store.js";

export const QA_CODEX_OAUTH_PROFILE_ID = "openai:qa-oauth";
export const QA_OPENAI_API_KEY_PROFILE_ID = "openai:media-api";
export const QA_AUTH_PROFILE_STORE_VERSION = 1;

export type QaAuthProfileShape = "oauth-only" | "apikey-only" | "mixed";

type QaAuthProfile = Extract<AuthProfileCredential, { type: "api_key" | "oauth" }>;

export type QaAuthProfileSnapshot = {
  version: number;
  profiles: Record<string, QaAuthProfile>;
};

export type QaCodexAuthProfileSelection =
  | {
      status: "ready";
      profileId: string;
      provider: "openai";
      mode: "oauth";
    }
  | {
      status: "blocked";
      remediation: string;
    };

export async function seedAuthProfiles(
  shape: QaAuthProfileShape,
  params: { agentId: string; stateDir: string },
): Promise<QaAuthProfileSnapshot> {
  const profiles: Record<string, QaAuthProfile> = {};
  if (shape !== "apikey-only") {
    profiles[QA_CODEX_OAUTH_PROFILE_ID] = {
      type: "oauth",
      provider: "openai",
      access: "qa-codex-oauth-access-placeholder",
      refresh: "qa-codex-oauth-refresh-placeholder",
      expires: Date.UTC(2036, 0, 1),
      email: "qa-codex@example.test",
      displayName: "QA Codex OAuth profile",
    };
  }
  if (shape !== "oauth-only") {
    profiles[QA_OPENAI_API_KEY_PROFILE_ID] = {
      type: "api_key",
      provider: "openai",
      key: "qa-openai-not-a-real-key",
      displayName: "QA OpenAI API-key profile",
    };
  }
  const snapshot = {
    version: QA_AUTH_PROFILE_STORE_VERSION,
    profiles,
  };
  await writeQaAuthProfiles({
    ...params,
    profiles: snapshot.profiles,
    replace: true,
  });
  return snapshot;
}

export async function snapshotAuthProfiles(agentDir: string): Promise<QaAuthProfileSnapshot> {
  const store = readQaAuthProfiles(agentDir);
  return {
    version: store.version,
    profiles: Object.fromEntries(
      Object.entries(store.profiles)
        .filter(
          (entry): entry is [string, QaAuthProfile] =>
            entry[1].provider === "openai" &&
            (entry[1].type === "oauth" || entry[1].type === "api_key"),
        )
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function resolveCodexAuthProfile(
  snapshot: QaAuthProfileSnapshot,
): QaCodexAuthProfileSelection {
  const profileId = Object.keys(snapshot.profiles)
    .toSorted((left, right) => left.localeCompare(right))
    .find((candidate) => {
      const profile = snapshot.profiles[candidate];
      return profile?.type === "oauth" && profile.provider === "openai";
    });

  if (!profileId) {
    return {
      status: "blocked",
      remediation:
        'Codex app-server auth requires an openai OAuth profile. Run "openclaw doctor --fix" to repair Codex auth routing before retrying.',
    };
  }

  return {
    status: "ready",
    profileId,
    provider: "openai",
    mode: "oauth",
  };
}
