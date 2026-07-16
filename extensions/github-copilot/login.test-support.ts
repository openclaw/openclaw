import "./login.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

type LoginTestApi = {
  setGitHubCopilotDeviceFlowFetchGuardForTesting: (impl: typeof fetchWithSsrFGuard | null) => void;
  withGithubCopilotDomainConfig: (config: OpenClawConfig, domain: string) => OpenClawConfig;
};

const api = Reflect.get(globalThis, Symbol.for("openclaw.githubCopilotLoginTestApi"));
if (!api) {
  throw new Error("GitHub Copilot login test API is unavailable");
}

export const { setGitHubCopilotDeviceFlowFetchGuardForTesting, withGithubCopilotDomainConfig } =
  api as LoginTestApi;
