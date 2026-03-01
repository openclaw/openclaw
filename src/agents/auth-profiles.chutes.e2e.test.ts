import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
} from "./auth-profiles.js";
import { CHUTES_TOKEN_ENDPOINT, type ChutesStoredOAuth } from "./chutes-oauth.js";

describe("auth-profiles (chutes)", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let tempDir: string | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  it("refreshes expired Chutes OAuth credentials", async () => {
    envSnapshot = captureEnv([
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
      "CHUTES_CLIENT_ID",
    ]);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chutes-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_AGENT_DIR = path.join(tempDir, "agents", "main", "agent");
    process.env.PI_CODING_AGENT_DIR = process.env.OPENCLAW_AGENT_DIR;

    const authProfilePath = path.join(tempDir, "agents", "main", "agent", "auth-profiles.json");
    await fs.mkdir(path.dirname(authProfilePath), { recursive: true });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "chutes:default": {
          type: "oauth",
          provider: "chutes",
          access: "at_old",
          refresh: "rt_old",
          expires: Date.now() - 60_000,
          clientId: "cid_test",
        } as unknown as ChutesStoredOAuth,
      },
    };
    await fs.writeFile(authProfilePath, `${JSON.stringify(store)}\n`);

    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== CHUTES_TOKEN_ENDPOINT) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          access_token: "at_new",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const loaded = ensureAuthProfileStore();
    const resolved = await resolveApiKeyForProfile({
      store: loaded,
      profileId: "chutes:default",
    });

    expect(resolved?.apiKey).toBe("at_new");
    expect(fetchSpy).toHaveBeenCalled();

    const persisted = JSON.parse(await fs.readFile(authProfilePath, "utf8")) as {
      profiles?: Record<string, { access?: string }>;
    };
    expect(persisted.profiles?.["chutes:default"]?.access).toBe("at_new");
  });
});
