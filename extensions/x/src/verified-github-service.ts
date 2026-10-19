import type { OpenClawPluginApi, OpenClawPluginServiceV2 } from "openclaw/plugin-sdk/plugin-entry";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { listXAccountIds, resolveXAccount } from "./accounts.js";
import { openXAllowlist } from "./allowlist.js";
import { getXApi } from "./client.js";
import { createXGitHubReader, XGitHubError } from "./github.js";
import { XBudgetExceededError } from "./spend.js";
import { emptyXGitHubSnapshot, syncXGitHub } from "./verified-github.js";

export function createXGitHubService(
  api: Pick<OpenClawPluginApi, "runtime">,
): OpenClawPluginServiceV2 {
  let activeAccounts: string[] = [];
  return {
    id: "x-verified-github",
    apiVersion: 2,
    reload: { configPrefixes: ["channels.x"] },
    start(context) {
      const readConfig = createRuntimeConfigReader(context.config);
      const cfg = readConfig();
      const allowlist = openXAllowlist(api.runtime);
      activeAccounts = listXAccountIds(cfg);
      for (const accountId of activeAccounts) {
        allowlist.invalidate(accountId);
        const account = resolveXAccount(cfg, accountId);
        const settings = account.config.verifiedFromGitHub;
        if (!account.enabled || !account.configured || !settings?.repo) {
          continue;
        }
        const capturedConfig = JSON.stringify(account.config);
        const assertCurrent = () => {
          context.scheduler.signal.throwIfAborted();
          if (JSON.stringify(resolveXAccount(readConfig(), accountId).config) !== capturedConfig) {
            throw new Error("X GitHub verification configuration changed");
          }
        };
        let github: ReturnType<typeof createXGitHubReader> | undefined;
        let failed = false;
        context.scheduler.schedule({
          id: accountId,
          delayMs: 0,
          everyMs: (settings.refreshMinutes ?? 60) * 60_000,
          run: async () => {
            try {
              assertCurrent();
              const token = resolveSecretInputString({
                value: settings.token,
                defaults: cfg.secrets?.defaults,
                path: `channels.x.accounts.${accountId}.verifiedFromGitHub.token`,
                mode: "strict",
              }).value;
              if (!token) {
                throw new XGitHubError(
                  "Configure verifiedFromGitHub.token with a GitHub credential that can list repository collaborators.",
                );
              }
              github ??= createXGitHubReader({ token });
              await syncXGitHub({
                runtime: api.runtime,
                account,
                github,
                getApi: () => getXApi(accountId, readConfig()),
                signal: context.scheduler.signal,
                assertCurrent,
              });
              failed = false;
            } catch (error) {
              if (context.scheduler.signal.aborted) {
                return;
              }
              assertCurrent();
              const message =
                error instanceof XGitHubError || error instanceof XBudgetExceededError
                  ? error.message
                  : "GitHub verification failed; check the configured credentials and Gateway logs. The last verified set is unchanged.";
              if (!failed) {
                context.logger.warn(`X GitHub verification (${accountId}): ${message}`);
                failed = true;
              }
              const previous = await allowlist.readGitHub(accountId, settings);
              await allowlist.replaceGitHub(
                accountId,
                { ...(previous ?? emptyXGitHubSnapshot(account)), stale: true, message },
                assertCurrent,
              );
            }
          },
        });
      }
    },
    stop() {
      const allowlist = openXAllowlist(api.runtime);
      for (const accountId of activeAccounts) {
        allowlist.invalidate(accountId);
      }
      activeAccounts = [];
    },
  };
}
