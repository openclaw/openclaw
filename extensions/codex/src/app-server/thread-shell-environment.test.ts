import path from "node:path";
import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonObject } from "./protocol.js";
import type { CodexThreadConfigurationOptions } from "./thread-configuration-options.js";
import {
  createThreadRequestAppServerOptions as createAppServerOptions,
  createThreadRequestAttemptParams as createAttemptParams,
} from "./thread-lifecycle.test-fixtures.js";
import { buildThreadStartParams, buildThreadResumeParams } from "./thread-requests.js";
import {
  applyCodexManagedShellEnvironment,
  mergeCodexNativeShellEnvironment,
} from "./thread-shell-environment.js";

async function buildRequestConfig(
  action: "start" | "resume",
  options: Omit<CodexThreadConfigurationOptions, "appServer">,
) {
  const shared = { appServer: createAppServerOptions(), ...options };
  const params = createAttemptParams({ provider: "openai" });
  return (
    action === "start"
      ? await buildThreadStartParams(params, { ...shared, cwd: "/repo", dynamicTools: [] })
      : await buildThreadResumeParams(params, { ...shared, threadId: "thread-1" })
  ).config;
}

function shellPolicy(config: JsonObject | undefined) {
  const policy = config?.shell_environment_policy;
  if (!isJsonObject(policy)) {
    throw new Error("expected shell environment policy");
  }
  return policy;
}

describe("Codex managed shell environment", () => {
  const nativeGit = "'user.name=Native' 'user.email=native@example.invalid'";
  const authoredGit = "'user.name=Native'";
  const setGit = (value: string) => ({ GIT_CONFIG_PARAMETERS: value });
  const includePath = { PATH: "include" };
  const credentialGit = setGit("'http.extraHeader=fixture-marker'");
  const gatewayPath = ["/tools", "/gateway/bin"].join(path.delimiter);
  const hostEnvironment = {
    PATH: "/host-tools:/usr/bin",
    GH_CONFIG_DIR: "/host-selected",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    PREVIEW_SERVICE_TOKEN: "",
  };
  it.each<[string, JsonObject | undefined, string?]>([
    ["ambient", undefined],
    ["authored native", { inherit: "none", set: setGit(nativeGit) }, nativeGit],
    ["authored + legacy include-only", { include_only: ["PATH"], set: credentialGit }, ""],
    ["authored + include filters", { filters: includePath, set: credentialGit }, ""],
    ["authored + exclusion", { exclude: ["GIT_*"], set: setGit(authoredGit) }, authoredGit],
    ["empty native", { set: setGit("") }, ""],
    ["inherit none", { inherit: "none" }, ""],
    ["inherit core", { inherit: "core" }, ""],
    ["legacy exclusion", { exclude: ["git_conf?g_*"] }, ""],
    ["legacy include-only", { include_only: ["PATH"] }, ""],
    [
      "filter exclusion wins over inclusion",
      { filters: { "git_*": "include", "git_conf?g_*": "exclude" } },
      "",
    ],
    ["filter excludes unlisted variables", { filters: includePath }, ""],
    ["filter admits inherited parameters", { filters: { "git_config_p?rameters": "include" } }],
  ])("Git append: %s", async (_label, policy, expectedBase) => {
    const parameters = "'maintenance.auto=false' 'gc.auto=0'";
    const options = {
      config: { shell_environment_policy: policy ?? {} },
      shellGitConfigParameters: parameters,
    };
    for (const action of ["start", "resume"] as const) {
      const merged = shellPolicy(await buildRequestConfig(action, options));
      if (expectedBase === undefined) {
        expect(merged.set).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
      } else {
        expect(merged.set).toMatchObject({
          GIT_CONFIG_PARAMETERS: expectedBase ? `${expectedBase} ${parameters}` : parameters,
        });
      }
    }
  });

  it("omits null policy overrides", () => {
    expect(
      mergeCodexNativeShellEnvironment(undefined, {
        inherit: null,
        set: { PATH: "" },
      }),
    ).toEqual({ shell_environment_policy: { set: { PATH: "" } } });
  });

  it("respects platform PATH casing", () => {
    const result = applyCodexManagedShellEnvironment(
      { shell_environment_policy: { set: { PATH: "/native/bin" } } },
      { Path: gatewayPath },
      true,
      ["/tools"],
    );
    const merged = ["/tools", "/native/bin"].join(path.delimiter);
    expect(result.shell_environment_policy).toMatchObject({
      set:
        process.platform === "win32"
          ? { PATH: merged, Path: merged }
          : { PATH: "/native/bin", Path: gatewayPath },
    });
  });

  it.each([
    { label: "inherited", expected: "/gateway/bin" },
    { label: "empty request", nativePath: "/native/bin", requestPath: "", expected: "" },
  ])("preserves $label PATH base", ({ nativePath, requestPath, expected }) => {
    const config = mergeCodexNativeShellEnvironment(
      requestPath === undefined ? undefined : { "shell_environment_policy.set.PATH": requestPath },
      {
        inherit: "none",
        set: {
          ...(nativePath === undefined ? {} : { PATH: nativePath }),
          KEEP: "yes",
          GH_TOKEN: "fixture",
        },
      },
    );
    const apply = (input: JsonObject) =>
      applyCodexManagedShellEnvironment(input, { PATH: gatewayPath, GH_TOKEN: "" }, true, [
        "/tools",
      ]);
    const result = apply(config ?? {});
    expect(result.shell_environment_policy).toMatchObject({
      inherit: "none",
      set: {
        PATH: ["/tools", ...(expected ? [expected] : [])].join(path.delimiter),
        KEEP: "yes",
        GH_TOKEN: "",
      },
    });
    expect(Object.hasOwn(result, "shell_environment_policy.set.PATH")).toBe(false);
    expect(apply(result)).toEqual(result);
  });

  it.each([
    { action: "start" as const, inherit: "none" },
    { action: "resume" as const, inherit: "core" },
  ])("host overlay: $action / $inherit", async ({ action, inherit }) => {
    const policy = {
      inherit,
      experimental_use_profile: true,
      exclude: ["GIT_*"],
      set: { GH_CONFIG_DIR: "/user-selected", KEEP_ME: "yes", PATH: "/user-selected/bin" },
      include_only: ["PATH"],
    };
    const config = await buildRequestConfig(action, {
      config: { allow_login_shell: true, shell_environment_policy: policy },
      shellEnvironment: hostEnvironment,
      disableLoginShell: true,
      shellPathPrepend: ["/host-tools"],
    });

    const shellEnvironmentPolicy = shellPolicy(config);
    expect(config).toMatchObject({
      allow_login_shell: false,
      shell_environment_policy: {
        ...policy,
        experimental_use_profile: false,
        set: {
          ...policy.set,
          ...hostEnvironment,
          PATH: ["/host-tools", "/user-selected/bin"].join(path.delimiter),
        },
        include_only: expect.arrayContaining(Object.keys(hostEnvironment)),
      },
    });
    expect(shellEnvironmentPolicy.include_only).toHaveLength(5);
    expect(shellEnvironmentPolicy).not.toHaveProperty("use_profile");
  });

  it("disables login profiles only for protected environments", async () => {
    const protectedEnv = { GH_TOKEN: "", GITHUB_TOKEN: "" };
    const build = async (
      config: JsonObject,
      shellEnvironment?: Readonly<Record<string, string>>,
      disableLoginShell?: boolean,
    ) => await buildRequestConfig("resume", { config, shellEnvironment, disableLoginShell });

    expect((await build({ allow_login_shell: true }))?.allow_login_shell).toBe(true);
    expect(await build({})).not.toHaveProperty("allow_login_shell");
    expect(await build({}, protectedEnv)).not.toHaveProperty("allow_login_shell");
    expect((await build({}, protectedEnv, true))?.allow_login_shell).toBe(false);
  });

  it.each<[string, Readonly<Record<string, string>> | undefined, boolean]>([
    ["absent", undefined, true],
    ["empty", {}, true],
    ["protected", { GH_TOKEN: "" }, false],
  ])("profile policy: %s environment", async (_label, shellEnvironment, expectedProfile) => {
    const config = await buildRequestConfig("resume", {
      config: { shell_environment_policy: { experimental_use_profile: true } },
      shellEnvironment,
      shellGitConfigParameters: "'maintenance.auto=false' 'gc.auto=0'",
    });
    expect(shellPolicy(config).experimental_use_profile).toBe(expectedProfile);
  });

  it("admits host values through case-insensitive restrictive filters", async () => {
    const options = {
      config: {
        shell_environment_policy: {
          experimental_use_profile: true,
          filters: {
            KEEP_ME: "include",
            path: "exclude",
            gh_token: "exclude",
            "GIT_*": "exclude",
          },
          set: { KEEP_ME: "yes" },
        },
      },
      shellEnvironment: {
        PATH: hostEnvironment.PATH,
        Path: hostEnvironment.PATH,
        GH_CONFIG_DIR: hostEnvironment.GH_CONFIG_DIR,
        GH_TOKEN: "",
        PREVIEW_SERVICE_TOKEN: "",
      },
      disableLoginShell: true,
    };
    const policy = shellPolicy(await buildRequestConfig("start", options));

    expect(policy).toMatchObject({
      experimental_use_profile: false,
      set: { KEEP_ME: "yes", ...options.shellEnvironment },
      filters: {
        KEEP_ME: "include",
        "GIT_*": "exclude",
        path: "include",
        gh_config_dir: "include",
        gh_token: "include",
        preview_service_token: "include",
      },
    });
    expect(Object.keys(policy.filters ?? {})).toHaveLength(6);
    expect(policy).not.toHaveProperty("include_only");
  });
});
