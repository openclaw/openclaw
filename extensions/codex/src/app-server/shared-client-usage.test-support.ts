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
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

/** Reuses the shared-client suite's auth fixtures and lifecycle cleanup. */
export function registerSharedClientUsageTests() {
  it.each([
    "fresh",
    "configured",
    "stale",
    "disabled",
    "account",
    "profile",
    "agent",
    "config",
    "retired",
  ] as const)(
    "reads usage from a matching live subscription only when its cache is fresh: %s",
    async (scenario) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
      const live = createInitializingClientHarness();
      const isolated = createClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as { id: number; method: string };
          if (request.method === "initialize") {
            send({
              id: request.id,
              result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
            });
          } else if (request.method === "account/rateLimits/read") {
            send({ id: request.id, result: { rateLimits: { primary: { usedPercent: 80 } } } });
          } else if (request.method === "account/read") {
            send({ id: request.id, result: { account: null } });
          }
        },
      });
      const start = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(live.client)
        .mockResolvedValueOnce(isolated.client);
      const profileId = "openai:usage";
      const credential = {
        type: "oauth" as const,
        provider: "openai",
        accountId: "account-usage",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
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
      if (scenario === "stale") {
        now.mockReturnValue(160_000);
      }
      if (scenario === "configured") {
        now.mockReturnValue(190_000);
      }
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
        config: {
          models: {
            usage: {
              cacheTtlMs:
                scenario === "disabled" ? 0 : scenario === "configured" ? 120_000 : 60_000,
            },
          },
        },
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
