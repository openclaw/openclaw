import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { ensureAuthProfileStore, markAuthProfileUsed } from "./auth-profiles.js";

describe("auth profile runtime snapshot external updates", () => {
  it("preserves out-of-process order updates when runtime later writes usage stats", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-external-"));
    const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
    const workerAgentDir = path.join(stateDir, "agents", "worker", "agent");
    const workerAuthPath = path.join(workerAgentDir, "auth-profiles.json");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;

    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await fs.mkdir(mainAgentDir, { recursive: true });
      await fs.mkdir(workerAgentDir, { recursive: true });

      await fs.writeFile(
        path.join(mainAgentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "openai-codex:dillan": {
                type: "token",
                provider: "openai-codex",
                token: "tok-dillan",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await fs.writeFile(
        workerAuthPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {},
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {
          agents: {
            list: [{ id: "worker" }],
          },
        },
      });
      activateSecretsRuntimeSnapshot(snapshot);

      const runtimeBefore = ensureAuthProfileStore(workerAgentDir);
      expect(runtimeBefore.order?.["openai-codex"]).toBeUndefined();

      // Simulate an external CLI process writing a new per-agent order.
      await fs.writeFile(
        workerAuthPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {},
            order: {
              "openai-codex": ["openai-codex:dillan"],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const runtimeAfterExternalWrite = ensureAuthProfileStore(workerAgentDir);
      expect(runtimeAfterExternalWrite.order?.["openai-codex"]).toEqual(["openai-codex:dillan"]);

      await markAuthProfileUsed({
        store: runtimeAfterExternalWrite,
        profileId: "openai-codex:dillan",
        agentDir: workerAgentDir,
      });

      const persisted = JSON.parse(await fs.readFile(workerAuthPath, "utf8")) as {
        order?: Record<string, string[]>;
      };
      expect(persisted.order?.["openai-codex"]).toEqual(["openai-codex:dillan"]);
    } finally {
      clearSecretsRuntimeSnapshot();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
