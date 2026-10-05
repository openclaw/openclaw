import { tempWorkspace } from "@openclaw/fs-safe/temp";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareWorkerGitHubBindingGrant } from "../gateway/worker-environments/worker-github-binding.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/temp-download.js";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "./admitted-run-context.js";
import {
  managedGitHubIdentityEnvironment,
  writeManagedGitHubProfileFiles,
} from "./github-tool-identity.js";

/** Native commands own a private copy of the selected account, not a new App authorization. */
export async function prepareLocalGitHubEnvironment(params: {
  admittedRunContext: AdmittedRunContext;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  assertCurrent: () => void;
  signal: AbortSignal;
}) {
  params.assertCurrent();
  if (!params.sessionId || !params.sessionKey) {
    return undefined;
  }
  const grant = await prepareWorkerGitHubBindingGrant({
    agentId: params.agentId ?? "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    operatorAuthority: readAdmittedRunOperatorAuthority(params.admittedRunContext),
    signal: params.signal,
    assertCurrent: () => {
      params.assertCurrent();
      params.signal.throwIfAborted();
      return true;
    },
  });
  if (!grant) {
    return undefined;
  }
  let workspace: Awaited<ReturnType<typeof tempWorkspace>> | undefined;
  let released = false;
  let cleanup: Promise<void> | undefined;
  let stopRenewal: (() => void) | undefined;
  const assertCurrent = () => {
    params.assertCurrent();
    params.signal.throwIfAborted();
    if (released) {
      throw new Error("Local GitHub credential lifetime has ended");
    }
    grant.assertCurrent?.();
  };
  const dispose = (): Promise<void> => {
    released = true;
    stopRenewal?.();
    cleanup ??= Promise.resolve()
      .then(async () => {
        await grant.revoke();
        await workspace?.cleanup();
      })
      .finally(() => {
        cleanup = undefined;
      });
    return cleanup;
  };
  try {
    assertCurrent();
    workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "github-local-run-",
    });
    const profileDir = workspace.dir;
    const { host = "github.com", login, gitAuthor } = grant.binding;
    await writeManagedGitHubProfileFiles(
      profileDir,
      { host, login, token: grant.binding.token },
      { assertCurrent },
    );
    assertCurrent();
    stopRenewal = grant.startRenewal?.(async (snapshot) => {
      assertCurrent();
      await writeManagedGitHubProfileFiles(
        profileDir,
        { host, login, token: snapshot.token },
        { assertCurrent },
      );
      assertCurrent();
    });
    assertCurrent();
    return {
      assertCurrent,
      dispose,
      ...(grant.signal ? { signal: grant.signal } : {}),
      instructions: `Local git and gh use the selected GitHub account ${login} on ${host}. Its private execution profile refreshes while this run remains current and is removed through run cleanup.`,
      env: {
        ...managedGitHubIdentityEnvironment({
          profileDir,
          gitAuthor,
          gitConfig: [
            ["credential.helper", ""],
            ["credential.helper", "!gh auth git-credential"],
            ["user.useConfigOnly", "true"],
          ],
        }),
        ...(!gitAuthor
          ? {
              GIT_AUTHOR_NAME: "",
              GIT_AUTHOR_EMAIL: "",
              GIT_COMMITTER_NAME: "",
              GIT_COMMITTER_EMAIL: "",
            }
          : {}),
        GH_HOST: host,
        OPENCLAW_GITHUB_EXECUTION_KIND: grant.binding.executionKind ?? "",
        OPENCLAW_GATEWAY_PASSWORD: "",
        GITHUB_APP_PRIVATE_KEY: "",
        OPENCLAW_GITHUB_APP_PRIVATE_KEY: "",
        GH_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GITHUB_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: gitNullConfigPath(),
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
