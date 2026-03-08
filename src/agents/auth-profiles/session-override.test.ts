import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { expectedOpenAICodexProfileId, makeJwt } from "../../test-utils/openai-codex-profile-id.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

async function writeAuthStore(agentDir: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "zai:work": { type: "api_key", provider: "zai", key: "sk-test" },
    },
    order: {
      zai: ["zai:work"],
    },
  };
  await fs.writeFile(authPath, JSON.stringify(payload), "utf-8");
}

describe("resolveSessionAuthProfileOverride", () => {
  it("keeps user override when provider alias differs", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir);

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "z.ai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("zai:work");
      expect(sessionEntry.authProfileOverride).toBe("zai:work");
    });
  });

  it("resolves legacy openai-codex session override without rewriting stored state", async () => {
    await withStateDirEnv("openclaw-auth-openai-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });

      const canonicalProfileId = expectedOpenAICodexProfileId({
        accountId: "acct-session",
        iss: "https://auth.openai.com",
        sub: "sub-session",
      });
      const authPath = path.join(agentDir, "auth-profiles.json");
      await fs.writeFile(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            [canonicalProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: makeJwt({
                iss: "https://auth.openai.com",
                sub: "sub-session",
                "https://api.openai.com/auth": { chatgpt_account_id: "acct-session" },
              }),
              refresh: "refresh-session",
              expires: Date.now() + 60_000,
              email: "user@example.com",
              accountId: "acct-session",
            },
          },
          order: { "openai-codex": [canonicalProfileId] },
        }),
        "utf-8",
      );

      const sessionEntry: SessionEntry = {
        sessionId: "s-openai",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:user@example.com",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {
          auth: {
            profiles: {
              [canonicalProfileId]: {
                provider: "openai-codex",
                mode: "oauth",
                email: "user@example.com",
              },
            },
            order: { "openai-codex": [canonicalProfileId] },
          },
        } as OpenClawConfig,
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe(canonicalProfileId);
      expect(sessionEntry.authProfileOverride).toBe("openai-codex:user@example.com");
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
      expect(sessionStore["agent:main:main"]?.authProfileOverride).toBe(
        "openai-codex:user@example.com",
      );
    });
  });
});
