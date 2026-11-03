import { expect, it, vi } from "vitest";
import { prepareCodexAppServerAuthBinding } from "./auth-binding.js";
import { resolveCodexAppServerAuthProfileStore } from "./auth-profile.js";
import { CodexAppServerClient } from "./client.js";
import { readCodexAppServerUsage } from "./request.js";
import {
  createInitializingClientHarness,
  createStartOptions,
} from "./shared-client-start.test-support.js";
import {
  getSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness, createCodexTestOAuthProfile } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

/** Reuses the shared-client suite's auth fixtures and lifecycle cleanup. */
export function registerSharedClientUsageTests() {
  it.each([
    ["fresh", 0, 60_000],
    ["configured", 90_000, 120_000],
    ["stale", 60_000, 60_000],
    ["disabled", 0, 0],
    ["account", 0, 60_000],
    ["profile", 0, 60_000],
    ["agent", 0, 60_000],
    ["config", 0, 60_000],
    ["retired", 0, 60_000],
  ] as const)(
    "reads usage from a matching live subscription only when its cache is fresh: %s",
    async (scenario, age, cacheTtlMs) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
      const live = createInitializingClientHarness();
      const isolated = createClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as { id: number; method: string };
          const responses: Record<string, unknown> = {
            initialize: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
            "account/rateLimits/read": { rateLimits: { primary: { usedPercent: 80 } } },
            "account/read": { account: null },
          };
          if (Object.hasOwn(responses, request.method)) {
            send({ id: request.id, result: responses[request.method] });
          }
        },
      });
      const start = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(live.client)
        .mockResolvedValueOnce(isolated.client);
      const profileId = "openai:usage";
      const credential = {
        ...createCodexTestOAuthProfile("account-usage"),
        expires: 999_999_999,
      };
      const store = {
        version: 1 as const,
        profiles: { [profileId]: credential, "openai:another": { ...credential } },
      };
      vi.mocked(resolveCodexAppServerAuthProfileStore).mockResolvedValue(store);
      const agentDir = "/tmp/openclaw-agent";
      const startOptions = createStartOptions();
      const binding = await prepareCodexAppServerAuthBinding({
        authProfileId: profileId,
        authProfileStore: store,
        agentDir,
        config: {},
      });
      await getSharedCodexAppServerClient({
        startOptions,
        agentDir,
        timeoutMs: 1_000,
        preparedAuth: { kind: "profile", profileId, store },
        authRequirement: "subscription",
        authBindingFingerprint: binding?.fingerprint,
      });
      const observed = new Promise<void>((resolve) => {
        live.client.addNotificationHandler(() => resolve());
      });
      live.send({
        method: "account/rateLimits/updated",
        params: { rateLimits: { primary: { usedPercent: 25 } } },
      });
      await observed;
      now.mockReturnValue(100_000 + age);
      if (scenario === "account") {
        credential.accountId = "another-account";
      }
      if (scenario === "retired") {
        retireSharedCodexAppServerClientIfCurrent(live.client);
      }
      const result = await readCodexAppServerUsage({
        timeoutMs: 1_000,
        agentDir: scenario === "agent" ? "/tmp/another-agent" : agentDir,
        authProfileId: scenario === "profile" ? "openai:another" : profileId,
        startOptions:
          scenario === "config"
            ? { ...startOptions, args: ["app-server", "-c", "different=true"] }
            : startOptions,
        config: { models: { usage: { cacheTtlMs } } },
      });
      const cacheHit = scenario === "fresh" || scenario === "configured";
      expect(result.rateLimits).toMatchObject({
        rateLimits: { primary: { usedPercent: cacheHit ? 25 : 80 } },
      });
      expect(start).toHaveBeenCalledTimes(cacheHit ? 1 : 2);
      expect(live.writes.map((line) => JSON.parse(line).method)).not.toContain(
        "account/rateLimits/read",
      );
      isolated.client.close();
    },
  );
}
