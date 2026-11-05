import { resolveConfiguredGitHubHost } from "openclaw/plugin-sdk/native-github-account-host";
export {
  GITHUB_PUBLIC_HOST,
  resolveConfiguredGitHubHost,
  resolveConfiguredGitHubApiBaseUrl,
} from "openclaw/plugin-sdk/native-github-account-host";

export { GITHUB_PLUGIN_ID } from "./config-api.js";

export const CLEARED_GITHUB_CREDENTIALS = {
  GH_TOKEN: "",
  GH_ENTERPRISE_TOKEN: "",
  GITHUB_TOKEN: "",
  GITHUB_ENTERPRISE_TOKEN: "",
};

export function withGitHubToken(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return {
    ...env,
    GH_TOKEN: token,
    GH_ENTERPRISE_TOKEN: token,
    GITHUB_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
  };
}

export function githubRepositoryUrl(
  repository: string,
  host = resolveConfiguredGitHubHost(),
): string {
  return `https://${host}/${repository}.git`;
}
