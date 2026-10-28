import { isDeepStrictEqual } from "node:util";
import { getRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedGitLabExecCredential } from "./bash-tools.exec-runtime.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { applyVerifiedGitLabAuthor } from "./gitlab-exec-author.js";
import type { GitLabAccount } from "./gitlab-oauth-client.js";
import { prepareGitLabToolCredential } from "./gitlab-tool-identity.js";

/** Verify the selected actor before approval, then bind each later launch to that same actor. */
export async function prepareGitLabExecLaunch(params: {
  selected: boolean;
  host: "gateway" | "sandbox";
  sandbox?: BashSandboxConfig;
  workdir: string;
  config?: OpenClawConfig;
  agentId: string;
  env: Record<string, string>;
}): Promise<(() => Promise<PreparedGitLabExecCredential>) | undefined> {
  if (!params.selected) {
    return undefined;
  }
  let approvedGitLabActor: GitLabAccount | undefined;
  let gitlabCanonicalOrigin = false;
  const prepareCredential = async () => {
    const config = params.config ?? {};
    const oauthConfig = config.gateway?.gitlab;
    if (!oauthConfig) {
      throw new Error("Managed GitLab Identity is unavailable; configure its OAuth issuer.");
    }
    const credential = await prepareGitLabToolCredential({
      config,
      getCurrentConfig: () => getRuntimeConfigSnapshot() ?? config,
      agentId: params.agentId,
      oauthConfig,
    });
    if (approvedGitLabActor && !isDeepStrictEqual(credential.account, approvedGitLabActor)) {
      credential.close();
      throw new Error("Managed GitLab actor changed after command approval.");
    }
    const profileDir = credential.env.GLAB_CONFIG_DIR;
    if (!profileDir) {
      credential.close();
      throw new Error("Managed GitLab CLI profile is unavailable.");
    }
    if (params.host === "sandbox" && profileDir !== params.sandbox?.gitlabProfileDir) {
      credential.close();
      throw new Error("Sandbox GitLab Identity selection changed.");
    }
    return {
      profileDir,
      issuer: credential.issuer,
      assertCurrent: credential.assertCurrent,
      assertCurrentSync: credential.assertCurrentSync,
      close: credential.close,
      account: credential.account,
      author: gitlabCanonicalOrigin ? credential.account : undefined,
    };
  };
  const credential = await prepareCredential();
  try {
    approvedGitLabActor = credential.account;
    gitlabCanonicalOrigin = applyVerifiedGitLabAuthor({
      workdir: params.host === "sandbox" ? params.sandbox!.workspaceDir : params.workdir,
      issuer: credential.issuer,
      author: credential.account,
      env: params.env,
    });
  } finally {
    credential.close();
  }
  return prepareCredential;
}
