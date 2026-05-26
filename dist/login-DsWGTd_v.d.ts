import { n as RuntimeEnv } from "./runtime-CZFxIuHh.js";
//#region extensions/github-copilot/login.d.ts
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
export { runGitHubCopilotDeviceFlow as i, GitHubCopilotDeviceFlowResult as n, githubCopilotLoginCommand as r, GitHubCopilotDeviceFlowIO as t };