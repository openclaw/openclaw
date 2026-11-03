import { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-mutation";
import type { NativeGitHubPublicationApi as RepositoryPublicationApi } from "openclaw/plugin-sdk/native-github-publication-host";
import {
  captureNativeGitHubServiceHost as captureRepositoryServiceHost,
  installNativeGitHubPublicationProvider as installRepositoryPublicationProvider,
} from "openclaw/plugin-sdk/native-github-publication-host";
import { createNativeGitHubSessionReads as createRepositorySessionReads } from "openclaw/plugin-sdk/native-github-session-read";
import type { OpenClawPluginServiceV2 } from "openclaw/plugin-sdk/plugin-entry";
import {
  installRepositoryServices,
  installLegacyRepositoryOAuthLookup,
} from "../account-runtime-api.js";
import { createGitHubOAuthLifecycle } from "../oauth-lifecycle-api.js";
import { createGitHubPublicationProvider } from "../publication-provider-api.js";
import { startGitHubSessionPresentation } from "../session-presentation-service-api.js";
import { cleanupRetiredManagedGitHubProfiles } from "../tool-profile-cleanup-api.js";

/** The managed plugin service is the sole account maintenance owner. */
export function createRepositoryAccountService(
  instanceSignal: AbortSignal,
): OpenClawPluginServiceV2 {
  let stop: (() => Promise<void>) | undefined;
  return {
    apiVersion: 2,
    id: "github-repositories.accounts",
    async start(service) {
      const host = captureRepositoryServiceHost();
      if (!host) {
        throw new Error("GitHub account service requires an active Gateway service binding.");
      }
      const signal = AbortSignal.any([service.scheduler.signal, instanceSignal, host.identity]);
      const assertCurrent = () => {
        signal.throwIfAborted();
        host.assertCurrent();
      };
      assertCurrent();
      try {
        const cleanup = await cleanupRetiredManagedGitHubProfiles({
          config: host.getConfig(),
          env: process.env,
        });
        for (const warning of cleanup.warnings) {
          service.logger.warn(`managed GitHub profile cleanup: ${warning}`);
        }
      } catch (error) {
        service.logger.warn(
          `managed GitHub profile cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      assertCurrent();
      let oauth: ReturnType<typeof createGitHubOAuthLifecycle> | undefined = undefined;
      let uninstall: (() => void) | undefined = undefined;
      let uninstallLegacy: (() => void) | undefined = undefined;
      let presentation: ReturnType<typeof startGitHubSessionPresentation> | undefined = undefined;
      let publication: RepositoryPublicationApi | undefined;
      let uninstallPublication: (() => void) | undefined;
      // Failed startup retains custody before a constructor can acquire subscriptions.
      stop = async () => {
        uninstallPublication?.();
        uninstallLegacy?.();
        uninstall?.();
        await Promise.all([oauth?.stop(), presentation?.stop()]);
      };
      oauth = createGitHubOAuthLifecycle({
        scheduler: service.scheduler,
        getConfig: host.getConfig,
        getPersistedConfig: async () => {
          const { snapshot } = await readConfigFileSnapshotForWrite();
          if (!snapshot.valid) {
            throw new Error("Persisted config is invalid; run openclaw doctor before retrying.");
          }
          return snapshot.config;
        },
        warn: (message) => service.logger.warn(message),
      });
      const currentOauth = oauth;
      if (host.publicationAvailable) {
        const installed = await installRepositoryPublicationProvider(
          createGitHubPublicationProvider({
            signal,
            assertCurrent,
            getConfig: host.getConfig,
            refreshIdentity: (agentId) => currentOauth.refreshEffectiveIdentity(agentId),
            refreshPersonal: (owner) => currentOauth.personal.refresh(owner),
          }),
        );
        uninstallPublication = installed.uninstall;
        publication = installed.api;
        assertCurrent();
      }
      presentation = startGitHubSessionPresentation({
        reads: createRepositorySessionReads(),
        scheduler: service.scheduler,
        getConfig: host.getConfig,
      });
      uninstall = installRepositoryServices(host.identity, { oauth, publication }, signal);
      uninstallLegacy = await installLegacyRepositoryOAuthLookup(host.identity);
      assertCurrent();
      oauth.start();
    },
    async stop() {
      await stop?.();
      stop = undefined;
    },
  };
}
