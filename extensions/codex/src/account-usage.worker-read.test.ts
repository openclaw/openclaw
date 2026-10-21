import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { saveAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { handleCodexAccountUsage } from "./account-usage-runtime.js";
import { readCodexAppServerUsage } from "./app-server/request.js";

// mock-isolation: Exercise real auth storage without starting a Codex subprocess.
vi.mock("./app-server/request.js", () => ({ readCodexAppServerUsage: vi.fn() }));

it.each([false, true])(
  "checks persisted account authority off the main thread before disclosing usage (revoked: %s)",
  async (revoke) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentDir = state.agentDir("fixture");
      const profileId = "openai:usage-fixture";
      const config: OpenClawConfig = {
        agents: { entries: { fixture: { agentDir } } },
        plugins: { enabled: false },
      };
      await state.writeConfig(config);
      saveAuthProfileStore({ version: 1, profiles: {} }, undefined, {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      });
      await state.writeAuthProfiles(
        {
          version: 1,
          profiles: {
            [profileId]: { type: "token", provider: "openai", token: "synthetic-usage-token" },
          },
        },
        "fixture",
      );
      vi.mocked(readCodexAppServerUsage).mockImplementation(async (options) => {
        options.assertCurrent?.();
        if (revoke) {
          const updated = await updateAuthProfileStoreWithLock({
            agentDir,
            saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
            updater(store) {
              delete store.profiles[profileId];
              return true;
            },
          });
          expect(updated?.profiles[profileId]).toBeUndefined();
          expect(updated).not.toBeNull();
        }
        return {
          rateLimits: {
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: 42, windowDurationMins: 300 },
            },
          },
        };
      });
      const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
      const params = { agentId: "fixture", profileId };
      const sql = observeHostDataSql();
      try {
        await handleCodexAccountUsage({
          req: { type: "req", id: "usage-fixture", method: "codex.accountUsage", params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond,
          context: { getRuntimeConfig: () => config } as GatewayRequestHandlerOptions["context"],
          hasCurrentClientAuthority: () => true,
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          !revoke,
          revoke
            ? undefined
            : expect.objectContaining({
                providers: [expect.objectContaining({ provider: "openai" })],
              }),
          ...(revoke ? [expect.objectContaining({ code: "UNAVAILABLE" })] : []),
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        vi.mocked(readCodexAppServerUsage).mockReset();
      }
    });
  },
);
