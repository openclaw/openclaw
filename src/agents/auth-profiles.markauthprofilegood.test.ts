import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureAuthProfileStore,
  markAuthProfileGood,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";

describe("markAuthProfileGood", () => {
  it("stores lastGood under the normalized provider key so fallback success affects future selection", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-lastgood-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");

    try {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        authPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "z-ai:default": {
                type: "api_key",
                provider: "z-ai",
                key: "sk-a",
              },
              "z-ai:account2": {
                type: "api_key",
                provider: "z-ai",
                key: "sk-b",
              },
            },
            order: {
              zai: ["z-ai:default", "z-ai:account2"],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileGood({
        store,
        provider: "zai",
        profileId: "z-ai:account2",
        agentDir,
      });

      const persisted = JSON.parse(await fs.readFile(authPath, "utf8")) as {
        lastGood?: Record<string, string>;
      };

      expect(persisted.lastGood).toEqual({ zai: "z-ai:account2" });
      expect(
        resolveAuthProfileOrder({
          cfg: {},
          store,
          provider: "zai",
          preferredProfile: persisted.lastGood?.zai,
        }),
      ).toEqual(["z-ai:account2", "z-ai:default"]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
