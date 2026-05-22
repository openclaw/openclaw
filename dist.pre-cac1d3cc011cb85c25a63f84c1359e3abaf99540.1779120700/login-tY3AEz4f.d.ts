import { n as RuntimeEnv } from "./runtime-lEKWbTQa.js";
import { a as fetchWithSsrFGuard } from "./fetch-guard-DG95ojWq.js";
//#region extensions/github-copilot/login.d.ts
declare function _setGitHubCopilotDeviceFlowFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
type GitHubCopilotDeviceFlowResult = {
  status: "authorized";
  accessToken: string;
} | {
  status: "access_denied";
} | {
  status: "expired";
};
type GitHubCopilotDeviceFlowIO = {
  showCode(args: {
    verificationUrl: string;
    userCode: string;
    expiresInMs: number;
  }): Promise<void>;
  openUrl?: (url: string) => Promise<void>;
};
declare function runGitHubCopilotDeviceFlow(io: GitHubCopilotDeviceFlowIO): Promise<GitHubCopilotDeviceFlowResult>;
declare function githubCopilotLoginCommand(opts: {
  profileId?: string;
  yes?: boolean;
  agentDir?: string;
}, runtime: RuntimeEnv): Promise<void>;
//#endregion
export { runGitHubCopilotDeviceFlow as a, githubCopilotLoginCommand as i, GitHubCopilotDeviceFlowResult as n, _setGitHubCopilotDeviceFlowFetchGuardForTesting as r, GitHubCopilotDeviceFlowIO as t };