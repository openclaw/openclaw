import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "./store.js";
import { markAuthProfileFailure } from "./usage.js";

describe("auth profile usage cooldowns", () => {
  it("opens an auth circuit after repeated auth failures", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);

      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-usage-"));
      try {
        const authPath = path.join(agentDir, "auth-profiles.json");
        await fs.writeFile(
          authPath,
          JSON.stringify(
            {
              version: 1,
              profiles: {
                "openai:p1": { type: "api_key", provider: "openai", key: "sk-test" },
              },
              usageStats: {},
            },
            null,
            2,
          ),
        );
        const store = ensureAuthProfileStore(agentDir);

        await markAuthProfileFailure({
          store,
          profileId: "openai:p1",
          reason: "auth",
          agentDir,
        });
        await markAuthProfileFailure({
          store,
          profileId: "openai:p1",
          reason: "auth",
          agentDir,
        });
        await markAuthProfileFailure({
          store,
          profileId: "openai:p1",
          reason: "auth",
          agentDir,
        });

        const stats = store.usageStats?.["openai:p1"];
        expect(stats?.disabledReason).toBe("auth");
        expect(typeof stats?.disabledUntil).toBe("number");
        expect(stats?.disabledUntil).toBeGreaterThan(now);
        expect(stats?.cooldownUntil).toBeUndefined();
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
