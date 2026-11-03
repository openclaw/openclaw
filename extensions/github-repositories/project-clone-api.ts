import { captureNativeGitHubServiceHost as captureRepositoryServiceHost } from "openclaw/plugin-sdk/native-github-publication-host";
import type { GitOperationStarter } from "openclaw/plugin-sdk/process-runtime";
import { createManagedProjectCheckoutV1 } from "openclaw/plugin-sdk/repository-sources";
import type {
  ManagedProjectOptions,
  ManagedProjectSourceV1,
} from "openclaw/plugin-sdk/repository-sources";
import { resolveConfiguredGitHubHost } from "./host-api.js";
import {
  cloneProjectCheckout,
  ensureProjectCheckoutCommit,
  refreshProjectCheckout,
  resolveProjectCheckoutBase,
} from "./project-clone-runtime-api.js";
import { parseProjectGitUrl } from "./project-url-api.js";

type GitHubCheckoutOptions = ManagedProjectOptions & {
  token?: string;
  startRun?: GitOperationStarter;
};

function checkout(options: GitHubCheckoutOptions) {
  const transport =
    (run: typeof cloneProjectCheckout): ManagedProjectSourceV1["clone"] =>
    (input, supplied) =>
      run(input, { ...options, ...supplied });
  return createManagedProjectCheckoutV1({
    resolveUrl(url) {
      const host = captureRepositoryServiceHost();
      if (!host) {
        throw new Error("GitHub checkout requires an admitted Gateway binding.");
      }
      host.assertCurrent();
      return parseProjectGitUrl(url, resolveConfiguredGitHubHost(host.getConfig()));
    },
    invalidUrlMessage:
      "Use a GitHub HTTPS or git@github.com repository URL. Local paths and file URLs are not accepted.",
    clone: transport(cloneProjectCheckout),
    ensureCommit: (input, supplied) =>
      ensureProjectCheckoutCommit(input, { ...options, ...supplied }),
    refresh: (input, supplied) => refreshProjectCheckout(input, { ...options, ...supplied }),
    resolveBase: (input, supplied) =>
      resolveProjectCheckoutBase(input, { ...options, ...supplied }),
  });
}

/** Credentials stay in this plugin's transport closure, never the generic host options. */
export async function materializeProjectClone(
  input: Parameters<ReturnType<typeof createManagedProjectCheckoutV1>["materialize"]>[0],
  options: GitHubCheckoutOptions = {},
) {
  const { signal, timeoutMs, assertCurrent } = options;
  return await checkout(options).materialize(input, { signal, timeoutMs, assertCurrent });
}
export async function refreshProjectClone(
  project: Parameters<ReturnType<typeof createManagedProjectCheckoutV1>["refresh"]>[0],
  options: GitHubCheckoutOptions = {},
) {
  const { signal, timeoutMs, assertCurrent } = options;
  return await checkout(options).refresh(project, { signal, timeoutMs, assertCurrent });
}

/** Resolve repository-owned base facts within the host's managed-checkout lease. */
export async function resolveProjectCloneBase(
  project: Parameters<ReturnType<typeof createManagedProjectCheckoutV1>["resolveBase"]>[0],
  ref?: string,
  options: GitHubCheckoutOptions = {},
) {
  const { signal, timeoutMs, assertCurrent } = options;
  return await checkout(options).resolveBase(project, ref, { signal, timeoutMs, assertCurrent });
}
