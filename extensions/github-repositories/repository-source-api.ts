import { getActiveSecretsRuntimeConfigSnapshot } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RepositorySourceV1 } from "openclaw/plugin-sdk/repository-sources";
import { readGitHubConfig } from "./config-api.js";
import { resolveConfiguredGitHubHost } from "./host-api.js";
import { materializeProjectClone, resolveProjectCloneBase } from "./project-clone-api.js";
import { parseProjectGitUrl } from "./project-url-api.js";
import { githubApiToken } from "./public-api.js";
import { prepareGitHubReadIdentity } from "./tool-identity-api.js";
import { createGitHubWorkerSource } from "./worker-source-api.js";

/** GitHub owns URL selection and credential custody; the host receives checkout facts only. */
export function createGitHubRepositorySource(
  getRuntimeConfig: () => OpenClawConfig,
  refresh: (agentId: string) => Promise<void>,
): RepositorySourceV1 {
  return {
    id: "repositories",
    worker: createGitHubWorkerSource(getRuntimeConfig, refresh),
    resolve(raw) {
      const host = resolveConfiguredGitHubHost(getRuntimeConfig());
      const repository = parseProjectGitUrl(raw, host);
      return repository
        ? {
            ...repository,
            display: { identity: new URL(repository.url).pathname.slice(1, -4), host },
          }
        : undefined;
    },
    async prepare(input) {
      const config = getRuntimeConfig();
      input.assertCurrent();
      const configuredToken = githubApiToken(process.env, config);
      const identity =
        !configuredToken && readGitHubConfig(config).repositorySearch?.useNativeCredentials === true
          ? await prepareGitHubReadIdentity({
              agentId: input.agentId,
              config,
              sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
              getCurrentConfig: getRuntimeConfig,
              assertActive: input.assertCurrent,
              allowAppInstallation: false,
              refresh: async () => {},
            })
          : undefined;
      const assertCurrent = () => {
        input.assertCurrent();
        identity?.assertSelected();
      };
      assertCurrent();
      const options = {
        signal: input.signal,
        token: configuredToken ?? identity?.token,
        assertCurrent,
        startRun: identity?.start,
      };
      const project = await materializeProjectClone(
        { gitUrl: input.url, requiredCommit: input.requiredCommit },
        options,
      );
      assertCurrent();
      return {
        project: { id: project.id, repoRoot: project.repoRoot, source: project.source },
        assertCurrent,
        async resolveBase(ref) {
          assertCurrent();
          const base = await resolveProjectCloneBase(project, ref, options);
          assertCurrent();
          return base;
        },
      };
    },
  };
}
