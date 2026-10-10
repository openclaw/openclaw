import { isDeepStrictEqual } from "node:util";
import type { BrowserProfileConfig } from "openclaw/plugin-sdk/config-contracts";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { assertCdpEndpointAllowed } from "./cdp.helpers.js";
import {
  getOwnBrowserProfile,
  resolveBrowserConfig,
  type ResolvedBrowserConfig,
} from "./config.js";
import {
  BrowserConflictError,
  BrowserResourceExhaustedError,
  BrowserValidationError,
} from "./errors.js";
import { allocateCdpPort, getUsedPorts } from "./profiles.js";

type BrowserControlCredential = {
  kind: "token" | "password";
  value: string;
};

export async function persistBrowserControlCredential(
  credential: BrowserControlCredential,
): Promise<void> {
  await mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      draft.gateway = {
        ...draft.gateway,
        auth: {
          ...draft.gateway?.auth,
          [credential.kind]: credential.value,
        },
      };
    },
  });
}

export async function createBrowserProfileConfig(params: {
  name: string;
  resolved: ResolvedBrowserConfig;
  parsedCdpUrl?: string;
  userDataDir?: string;
  driver?: "openclaw" | "existing-session";
}): Promise<BrowserProfileConfig | undefined> {
  const mutation = await mutateConfigFile<BrowserProfileConfig>({
    afterWrite: { mode: "auto" },
    mutate: async (draft) => {
      const useRebasedPortRange = draft.gateway?.port !== undefined;
      const latestResolved = resolveBrowserConfig(
        {
          ...params.resolved,
          ...draft.browser,
          profiles: draft.browser?.profiles ?? params.resolved.profiles,
        },
        draft,
      );
      const latestRootResolved = resolveBrowserConfig(draft.browser, draft);
      const latestProfileSource = useRebasedPortRange ? latestRootResolved : latestResolved;
      const latestProfiles = draft.browser?.profiles ?? {};
      if (
        getOwnBrowserProfile(latestProfiles, params.name) ||
        getOwnBrowserProfile(latestProfileSource.profiles, params.name)
      ) {
        throw new BrowserConflictError(`profile "${params.name}" already exists`);
      }

      let nextProfileConfig: BrowserProfileConfig;
      if (params.parsedCdpUrl) {
        try {
          await assertCdpEndpointAllowed(params.parsedCdpUrl, latestResolved.ssrfPolicy);
        } catch (err) {
          throw new BrowserValidationError(formatErrorMessage(err));
        }
        nextProfileConfig = {
          cdpUrl: params.parsedCdpUrl,
          ...(params.driver ? { driver: params.driver } : {}),
          ...(params.driver === "existing-session" ? { attachOnly: true } : {}),
        };
      } else if (params.driver === "existing-session") {
        nextProfileConfig = {
          driver: params.driver,
          attachOnly: true,
          ...(params.userDataDir ? { userDataDir: params.userDataDir } : {}),
        };
      } else {
        const usedPorts = getUsedPorts(latestProfileSource.profiles);
        const rangeSource = useRebasedPortRange ? latestRootResolved : params.resolved;
        const cdpPort = allocateCdpPort(usedPorts, {
          start: rangeSource.cdpPortRangeStart,
          end: rangeSource.cdpPortRangeEnd,
        });
        if (cdpPort === null) {
          throw new BrowserResourceExhaustedError("no available CDP ports in range");
        }
        nextProfileConfig = {
          cdpPort,
          ...(params.driver ? { driver: params.driver } : {}),
        };
      }

      draft.browser = {
        ...draft.browser,
        profiles: {
          ...draft.browser?.profiles,
          [params.name]: nextProfileConfig,
        },
      };
      return nextProfileConfig;
    },
  });
  return mutation.result;
}

/** Delete the exact persisted browser profile definition captured by the caller. */
export async function deleteBrowserProfileConfig(params: {
  name: string;
  expected: BrowserProfileConfig;
}): Promise<void> {
  await mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (draft.browser?.defaultProfile === params.name) {
        throw new BrowserValidationError(
          `cannot delete the default profile "${params.name}"; change browser.defaultProfile first`,
        );
      }
      const currentProfile = getOwnBrowserProfile(draft.browser?.profiles, params.name);
      if (!isDeepStrictEqual(currentProfile, params.expected)) {
        throw new BrowserConflictError(
          `profile "${params.name}" changed while deletion was pending; retry the delete request`,
        );
      }
      const { [params.name]: _removed, ...remainingProfiles } = draft.browser?.profiles ?? {};
      draft.browser = {
        ...draft.browser,
        profiles: remainingProfiles,
      };
    },
  });
}

export async function setDefaultBrowserProfile(name: string): Promise<void> {
  await mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (!getOwnBrowserProfile(draft.browser?.profiles, name)) {
        throw new BrowserValidationError(`profile "${name}" does not exist`);
      }
      draft.browser = {
        ...draft.browser,
        defaultProfile: name,
      };
    },
  });
}
