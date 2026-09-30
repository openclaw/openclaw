import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasWorkerGitHubAppConfiguration,
  issueWorkerGitHubInstallationToken,
} from "../gateway/worker-environments/worker-github-installation-token.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/temp-download.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  onUserProfilesChanged,
  onUserProfileEmailBindingChanged,
} from "../state/user-profile-events.js";
import { getUserProfileDisplay, prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "./admitted-run-context.js";
import { resolveGitHubAppApiBaseUrl, resolveGitHubHost } from "./github-host.js";
import {
  managedGitHubIdentityEnvironment,
  resolveConfiguredGitHubToolIdentity,
  writeManagedGitHubProfileFiles,
} from "./github-tool-identity.js";

const log = createSubsystemLogger("agents/github-local-environment");

/** A local native run owns its profile; the shared harness process never receives it. */
export async function prepareLocalGitHubEnvironment(params: {
  admittedRunContext: AdmittedRunContext;
  agentId?: string;
  config?: OpenClawConfig;
  assertCurrent: () => void;
  signal: AbortSignal;
}) {
  if (!hasWorkerGitHubAppConfiguration()) {
    return undefined;
  }
  const config = params.config;
  if (
    config &&
    (["agent", "system"] as const).some((scope) =>
      resolveConfiguredGitHubToolIdentity({
        config,
        agentId: params.agentId ?? "",
        scope,
      }),
    )
  ) {
    return undefined;
  }
  params.assertCurrent();
  const operator = readAdmittedRunOperatorAuthority(params.admittedRunContext);
  if (!operator) {
    return undefined;
  }
  operator.assertCurrent();
  const profile = await prepareUserProfileIdentity(operator.profileId);
  const authorityAbort = new AbortController();
  const signal = AbortSignal.any([
    params.signal,
    authorityAbort.signal,
    ...(operator.signal ? [operator.signal] : []),
  ]);
  let grant: Awaited<ReturnType<typeof issueWorkerGitHubInstallationToken>>;
  let workspace: Awaited<ReturnType<typeof tempWorkspace>> | undefined;
  let released = false;
  let profileReleased = false;
  let cleanup: Promise<void> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let renewalWork: Promise<void> | undefined;
  const pendingRevocations = new Set<NonNullable<typeof grant>>();
  const subscriptions: (() => void)[] = [];
  const revoke = async (candidate: NonNullable<typeof grant>) => {
    pendingRevocations.add(candidate);
    try {
      await candidate.revoke();
      pendingRevocations.delete(candidate);
    } catch {
      log.warn("Local GitHub credential revocation failed; cleanup can retry before token expiry.");
    }
  };
  const dispose = (): Promise<void> => {
    released = true;
    clearTimeout(expiry);
    clearTimeout(renewal);
    signal.removeEventListener("abort", onAbort);
    subscriptions.splice(0).forEach((stop) => stop());
    authorityAbort.abort(new Error("Local GitHub credential authority closed"));
    if (!cleanup) {
      cleanup = (async () => {
        if (renewalWork) {
          await renewalWork.catch(() => undefined);
        }
        if (grant) {
          pendingRevocations.add(grant);
          grant = undefined;
        }
        await Promise.all([...pendingRevocations].map(revoke));
        try {
          await workspace?.cleanup();
        } catch {
          log.warn("Local GitHub profile cleanup failed; cleanup can retry.");
          return;
        }
        if (!profileReleased) {
          profile.release();
          profileReleased = true;
        }
      })().finally(() => {
        cleanup = undefined;
      });
    }
    return cleanup;
  };
  const onAbort = () => {
    void dispose();
  };
  let bindingIds: readonly string[] = [];
  const assertCurrent = () => {
    params.assertCurrent();
    signal.throwIfAborted();
    operator.assertCurrent();
    profile.readCurrentFacts(bindingIds);
    if (released || (grant && Date.now() >= grant.expiresAtMs)) {
      throw new Error("Local GitHub credential lifetime has ended");
    }
  };
  try {
    bindingIds = profile.emailBindingIds;
    assertCurrent();
    const host = resolveGitHubHost();
    const apiBaseUrl = resolveGitHubAppApiBaseUrl(host);
    // Factory's authenticated proxy binds an immutable host/account principal to
    // this profile. Display names, commit email, and the App actor are not a user.
    const prefix = `github:${host}:`;
    const accounts = profile
      .readCurrentFacts(bindingIds)
      .profile.emails.filter((value) => value.startsWith(prefix))
      .map((value) => value.slice(prefix.length));
    const account = accounts[0];
    if (accounts.length !== 1 || !account || !/^[1-9][0-9]*$/u.test(account)) {
      await dispose();
      return undefined;
    }
    const accountId = Number(account);
    if (!Number.isSafeInteger(accountId)) {
      await dispose();
      return undefined;
    }
    const email = profile
      .readCurrentFacts(bindingIds)
      .profile.emails.find((value) => value.includes("@"));
    if (!email) {
      await dispose();
      return undefined;
    }
    const gitAuthor = {
      name: getUserProfileDisplay(operator.profileId).displayName?.trim() || email,
      email,
    };
    grant = await issueWorkerGitHubInstallationToken({ host, signal });
    assertCurrent();
    if (!grant) {
      await dispose();
      return undefined;
    }
    if (resolveGitHubAppApiBaseUrl(host) !== apiBaseUrl) {
      throw new Error("Local GitHub App API changed during preparation");
    }
    const verifyGrant = async (candidate: NonNullable<typeof grant>) => {
      assertCurrent();
      if (resolveGitHubHost() !== host || resolveGitHubAppApiBaseUrl(host) !== apiBaseUrl) {
        throw new Error("Local GitHub App endpoint changed");
      }
      const response = await fetch(`${apiBaseUrl}/user/${accountId}`, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: {
          authorization: `Bearer ${candidate.token}`,
          accept: "application/vnd.github+json",
        },
      });
      if (!response.ok) {
        void response.body?.cancel();
        throw new Error("The signed-in GitHub account could not be resolved");
      }
      const identity: unknown = await response.json();
      const record = isRecord(identity) ? identity : {};
      const login =
        typeof record.login === "string" ? normalizeGitHubLogin(record.login) : undefined;
      if (record.id !== accountId || !login) {
        throw new Error("GitHub account identity did not match");
      }
      assertCurrent();
      return login;
    };
    const login = await verifyGrant(grant);
    assertCurrent();
    workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "github-local-run-",
    });
    const profileDir = workspace.dir;
    await writeManagedGitHubProfileFiles(profileDir, {
      host,
      login: "x-access-token",
      token: grant.token,
    });
    assertCurrent();
    const recheck = () => {
      try {
        assertCurrent();
      } catch {
        authorityAbort.abort();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    subscriptions.push(onUserProfilesChanged(recheck), onUserProfileEmailBindingChanged(recheck));
    const scheduleRenewal = (delayMs: number) => {
      renewal = setTimeout(() => {
        renewalWork = (async () => {
          assertCurrent();
          const next = await issueWorkerGitHubInstallationToken({ host, signal });
          if (!next) {
            throw new Error("Local GitHub App issuer unavailable");
          }
          try {
            await verifyGrant(next);
            assertCurrent();
            await writeManagedGitHubProfileFiles(profileDir, {
              host,
              login: "x-access-token",
              token: next.token,
            });
            assertCurrent();
            const previous = grant;
            grant = next;
            scheduleGrant();
            if (previous) {
              await revoke(previous);
            }
          } catch (error) {
            if (grant !== next) {
              await revoke(next);
            }
            throw error;
          }
        })();
        void renewalWork.catch(() => {
          if (released || signal.aborted) {
            return;
          }
          const remaining = (grant?.expiresAtMs ?? 0) - Date.now();
          log.warn("Local GitHub credential renewal failed.");
          if (remaining > 10_000) {
            scheduleRenewal(Math.min(60_000, remaining / 2));
          }
        });
      }, delayMs);
      renewal.unref?.();
    };
    const scheduleGrant = () => {
      clearTimeout(expiry);
      clearTimeout(renewal);
      if (!grant) {
        throw new Error("Local GitHub credential unavailable");
      }
      const remaining = grant.expiresAtMs - Date.now();
      expiry = setTimeout(onAbort, Math.max(0, remaining));
      expiry.unref?.();
      scheduleRenewal(Math.max(1, remaining > 600_000 ? remaining - 300_000 : remaining / 2));
    };
    scheduleGrant();
    return {
      assertCurrent,
      dispose,
      instructions: `Local git and gh use a run-scoped GitHub App installation credential for ${host}. The authenticated requesting user's verified login is ${login}; use that explicit login for assignee filters, never App @me or gh api user. Credentials renew while authority remains current and are removed at run completion, including for detached commands.`,
      env: {
        ...managedGitHubIdentityEnvironment({
          profileDir: workspace.dir,
          gitAuthor,
          gitConfig: [
            ["credential.helper", ""],
            ["credential.helper", "!gh auth git-credential"],
          ],
        }),
        GH_HOST: host,
        OPENCLAW_GATEWAY_PASSWORD: "",
        GITHUB_APP_PRIVATE_KEY: "",
        GH_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GITHUB_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
        GITHUB_USER_LOGIN: login,
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
