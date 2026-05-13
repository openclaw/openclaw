import path from "node:path";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";

type QaAuthProfileCredential =
  | {
      type: "api_key";
      provider: string;
      key: string;
      displayName?: string;
    }
  | {
      type: "token";
      provider: string;
      token: string;
    };

export function resolveQaAgentAuthDir(params: { stateDir: string; agentId: string }): string {
  return path.join(params.stateDir, "agents", params.agentId, "agent");
}

export async function writeQaAuthProfiles(params: {
  agentDir: string;
  stateDir: string;
  profiles: Record<string, QaAuthProfileCredential>;
}): Promise<void> {
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const existing = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir, { env });
  saveAuthProfileStore(
    {
      ...existing,
      profiles: {
        ...existing.profiles,
        ...(params.profiles as AuthProfileStore["profiles"]),
      },
    },
    params.agentDir,
    { env },
  );
}
