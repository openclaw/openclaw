import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveAuthProfileStore } from "./auth-profiles.js";
import { ensurePiAuthJsonFromAuthProfiles } from "./pi-auth-json.js";

describe("ensurePiAuthJsonFromAuthProfiles", () => {
  it("writes openai-codex oauth credentials into auth.json for pi-coding-agent discovery", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
      agentDir,
    );

    const first = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(first.wrote).toBe(true);

    const authPath = path.join(agentDir, "auth.json");
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
    expect(auth["openai-codex"]).toMatchObject({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
    });

    const second = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(second.wrote).toBe(false);
  });
});
