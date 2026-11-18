import {
  managedGitHubIdentityEnvironment,
  parseWorkerGitHubLaunchBinding,
  writeManagedGitHubProfileFiles,
  type WorkerGitHubLaunchBinding,
} from "openclaw/plugin-sdk/github-worker-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** One duplex's private profile; native children never pin its rotating bearer. */
export async function createCodexNodeGitHubCredential(params: {
  profileDir: string;
  binding: WorkerGitHubLaunchBinding;
  assertCurrent: () => void;
}) {
  let binding = params.binding;
  let generation = 0;
  let expiresAtMs: number | undefined;
  const assertCurrent = () => {
    params.assertCurrent();
    if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) {
      throw new Error("Worker GitHub credential expired");
    }
  };
  assertCurrent();
  await writeManagedGitHubProfileFiles(params.profileDir, binding, { assertCurrent });
  assertCurrent();
  const host = binding.host ?? "github.com";
  const environment = {
    ...managedGitHubIdentityEnvironment({
      profileDir: params.profileDir,
      host,
      gitAuthor: binding.gitAuthor,
      gitConfig: [
        ["credential.helper", ""],
        [`credential.https://${host}.helper`, "!gh auth git-credential"],
      ],
    }),
    GH_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GITHUB_TOKEN: "",
    GITHUB_ENTERPRISE_TOKEN: "",
  };
  return {
    environment,
    launchEnvironment() {
      assertCurrent();
      return {
        ...environment,
        ...(host === "github.com" || host.endsWith(".ghe.com")
          ? { GH_TOKEN: binding.token }
          : { GH_ENTERPRISE_TOKEN: binding.token }),
      };
    },
    async install(value: unknown) {
      assertCurrent();
      if (
        !isRecord(value) ||
        !Number.isSafeInteger(value.generation) ||
        typeof value.generation !== "number" ||
        value.generation < 0 ||
        (value.expiresAtMs !== undefined &&
          (typeof value.expiresAtMs !== "number" ||
            !Number.isSafeInteger(value.expiresAtMs) ||
            value.expiresAtMs <= Date.now())) ||
        Object.keys(value).some((key) => !["generation", "token", "expiresAtMs"].includes(key))
      ) {
        throw new Error("Worker GitHub refresh is invalid or expired");
      }
      const replacement = parseWorkerGitHubLaunchBinding({ ...params.binding, token: value.token });
      if (
        !replacement ||
        value.generation < generation ||
        (value.generation === generation && replacement.token !== binding.token)
      ) {
        throw new Error("Worker GitHub refresh generation changed");
      }
      if (value.generation > generation) {
        await writeManagedGitHubProfileFiles(params.profileDir, replacement, { assertCurrent });
        assertCurrent();
        binding = replacement;
        generation = value.generation;
        expiresAtMs = value.expiresAtMs;
      }
      return { generation };
    },
  };
}

export type CodexNodeGitHubCredential = Awaited<ReturnType<typeof createCodexNodeGitHubCredential>>;
