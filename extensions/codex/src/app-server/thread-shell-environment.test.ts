import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
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
  options: Pick<
    Parameters<typeof buildThreadStartParams>[1],
    | "config"
    | "shellEnvironment"
    | "disableLoginShell"
    | "shellPathPrepend"
    | "shellGitConfigParameters"
  >,
) {
  const shared = { appServer: createAppServerOptions(), ...options };
  const params = createAttemptParams({ provider: "openai" });
  return (
    action === "start"
      ? await buildThreadStartParams(params, { ...shared, cwd: "/repo", dynamicTools: [] })
      : await buildThreadResumeParams(params, { ...shared, threadId: "thread-1" })
  ).config;
}

describe("Codex managed shell environment", () => {
  it.each<{
    label: string;
    policy?: JsonObject;
    expectedBase?: string;
  }>([
    { label: "ambient" },
    {
      label: "authored native",
      policy: {
        inherit: "none",
        set: {
          GIT_CONFIG_PARAMETERS: "'user.name=Native' 'user.email=native@example.invalid'",
        },
      },
      expectedBase: "'user.name=Native' 'user.email=native@example.invalid'",
    },
    {
      label: "authored native excluded by legacy include-only",
      policy: {
        include_only: ["PATH"],
        set: { GIT_CONFIG_PARAMETERS: "'http.extraHeader=fixture-marker'" },
      },
      expectedBase: "",
    },
    {
      label: "authored native excluded by include filters",
      policy: {
        filters: { PATH: "include" },
        set: { GIT_CONFIG_PARAMETERS: "'http.extraHeader=fixture-marker'" },
      },
      expectedBase: "",
    },
    {
      label: "authored native survives exclusion-only",
      policy: {
        exclude: ["GIT_*"],
        set: { GIT_CONFIG_PARAMETERS: "'user.name=Native'" },
      },
      expectedBase: "'user.name=Native'",
    },
    {
      label: "empty native",
      policy: { set: { GIT_CONFIG_PARAMETERS: "" } },
      expectedBase: "",
    },
    { label: "inherit none", policy: { inherit: "none" }, expectedBase: "" },
    { label: "inherit core", policy: { inherit: "core" }, expectedBase: "" },
    {
      label: "legacy exclusion",
      policy: { exclude: ["git_conf?g_*"] },
      expectedBase: "",
    },
    {
      label: "legacy include-only",
      policy: { include_only: ["PATH"] },
      expectedBase: "",
    },
    {
      label: "filter exclusion wins over inclusion",
      policy: { filters: { "git_*": "include", "git_conf?g_*": "exclude" } },
      expectedBase: "",
    },
    {
      label: "filter excludes unlisted variables",
      policy: { filters: { PATH: "include" } },
      expectedBase: "",
    },
    {
      label: "filter admits inherited parameters",
      policy: { filters: { "git_config_p?rameters": "include" } },
    },
  ])("preserves $label Git configuration before the host append", async (fixture) => {
    const parameters = "'maintenance.auto=false' 'gc.auto=0'";
    const options = {
      config: { shell_environment_policy: fixture.policy ?? {} },
      shellGitConfigParameters: parameters,
    };
    for (const action of ["start", "resume"] as const) {
      const policy = (await buildRequestConfig(action, options))?.shell_environment_policy;
      if (!isJsonObject(policy)) {
        throw new Error("expected shell environment policy");
      }
      if (fixture.expectedBase === undefined) {
        expect(policy.set).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
      } else {
        expect(policy).toMatchObject({
          set: {
            GIT_CONFIG_PARAMETERS: fixture.expectedBase
              ? `${fixture.expectedBase} ${parameters}`
              : parameters,
          },
        });
      }
    }
  });

  it("omits native absent policy fields instead of sending null TOML overrides", () => {
    expect(
      mergeCodexNativeShellEnvironment(undefined, {
        inherit: null,
        ignore_default_excludes: null,
        exclude: null,
        include_only: null,
        filters: null,
        experimental_use_profile: null,
        set: { PATH: "" },
      }),
    ).toEqual({ shell_environment_policy: { set: { PATH: "" } } });
  });

  it("respects platform PATH casing", () => {
    const result = applyCodexManagedShellEnvironment(
      { shell_environment_policy: { set: { PATH: "/native/bin" } } },
      { Path: ["/tools", "/gateway/bin"].join(path.delimiter) },
      true,
      ["/tools"],
    );
    const merged = ["/tools", "/native/bin"].join(path.delimiter);
    expect(result.shell_environment_policy).toMatchObject({
      set:
        process.platform === "win32"
          ? { PATH: merged, Path: merged }
          : { PATH: "/native/bin", Path: ["/tools", "/gateway/bin"].join(path.delimiter) },
    });
  });

  it.each([
    { label: "inherited", expected: "/gateway/bin" },
    { label: "empty request", nativePath: "/native/bin", requestPath: "", expected: "" },
  ])(
    "prepends to the $label PATH without replacing its base",
    ({ nativePath, requestPath, expected }) => {
      const config = mergeCodexNativeShellEnvironment(
        requestPath === undefined
          ? undefined
          : { "shell_environment_policy.set.PATH": requestPath },
        {
          inherit: "none",
          set: {
            ...(nativePath === undefined ? {} : { PATH: nativePath }),
            KEEP: "yes",
            GH_TOKEN: "fixture",
          },
        },
      );
      const result = applyCodexManagedShellEnvironment(
        config ?? {},
        { PATH: ["/tools", "/gateway/bin"].join(path.delimiter), GH_TOKEN: "" },
        true,
        ["/tools"],
      );
      expect(result.shell_environment_policy).toMatchObject({
        inherit: "none",
        set: {
          PATH: ["/tools", ...(expected ? [expected] : [])].join(path.delimiter),
          KEEP: "yes",
          GH_TOKEN: "",
        },
      });
      expect(Object.hasOwn(result, "shell_environment_policy.set.PATH")).toBe(false);
      expect(
        applyCodexManagedShellEnvironment(
          result,
          { PATH: ["/tools", "/gateway/bin"].join(path.delimiter), GH_TOKEN: "" },
          true,
          ["/tools"],
        ),
      ).toEqual(result);
    },
  );

  it("merges dotted policy patches at their original precedence before the host overlay", () => {
    const config = mergeCodexThreadConfigs(
      { "shell_environment_policy.set.PATH": "/old", "shell_environment_policy.set.KEEP": "yes" },
      { shell_environment_policy: { set: { PATH: "/new" } } },
    );
    expect(config).toEqual({ shell_environment_policy: { set: { PATH: "/new", KEEP: "yes" } } });
  });

  it.each([
    { action: "start" as const, inherit: "none" },
    { action: "resume" as const, inherit: "core" },
  ])(
    "applies the host environment last for thread/$action with inherit=$inherit",
    async ({ action, inherit }) => {
      const options = {
        config: {
          allow_login_shell: true,
          shell_environment_policy: {
            inherit,
            experimental_use_profile: true,
            exclude: ["GIT_*"],
            set: { GH_CONFIG_DIR: "/user-selected", KEEP_ME: "yes", PATH: "/user-selected/bin" },
            include_only: ["PATH"],
          },
        },
        shellEnvironment: {
          PATH: "/host-tools:/usr/bin",
          GH_CONFIG_DIR: "/host-selected",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
          OPENCLAW_STATE_DIR: "/fixture/diagnosed",
          OPENCLAW_CONFIG_PATH: "/fixture/custom.json",
          OPENCLAW_WORKSPACE_DIR: "/fixture/default-workspace",
        },
        disableLoginShell: true,
        shellPathPrepend: ["/host-tools"],
      };
      const config = await buildRequestConfig(action, options);

      const shellEnvironmentPolicy = config?.shell_environment_policy;
      if (!isJsonObject(shellEnvironmentPolicy)) {
        throw new Error("expected shell environment policy");
      }
      expect(shellEnvironmentPolicy).toMatchObject({
        inherit,
        experimental_use_profile: false,
        exclude: ["GIT_*"],
        set: {
          ...options.shellEnvironment,
          PATH: ["/host-tools", "/user-selected/bin"].join(path.delimiter),
          KEEP_ME: "yes",
        },
      });
      expect(config?.allow_login_shell).toBe(false);
      const includeOnly = shellEnvironmentPolicy.include_only;
      expect(includeOnly).toHaveLength(8);
      expect(includeOnly).toEqual(expect.arrayContaining(Object.keys(options.shellEnvironment)));
      expect(shellEnvironmentPolicy.experimental_use_profile).toBe(false);
      expect(shellEnvironmentPolicy).not.toHaveProperty("use_profile");
    },
  );

  it("disables login profiles only for protected environments", async () => {
    const build = async (
      config: JsonObject,
      shellEnvironment?: Readonly<Record<string, string>>,
      disableLoginShell?: boolean,
    ) => await buildRequestConfig("resume", { config, shellEnvironment, disableLoginShell });

    expect((await build({ allow_login_shell: true }))?.allow_login_shell).toBe(true);
    expect(await build({})).not.toHaveProperty("allow_login_shell");
    expect(await build({}, { GH_TOKEN: "", GITHUB_TOKEN: "" })).not.toHaveProperty(
      "allow_login_shell",
    );
    expect((await build({}, { GH_TOKEN: "", GITHUB_TOKEN: "" }, true))?.allow_login_shell).toBe(
      false,
    );
  });

  it.each<{
    label: string;
    shellEnvironment?: Readonly<Record<string, string>>;
    expectedProfile: boolean;
  }>([
    { label: "absent", shellEnvironment: undefined, expectedProfile: true },
    { label: "empty", shellEnvironment: {}, expectedProfile: true },
    { label: "protected", shellEnvironment: { GH_TOKEN: "" }, expectedProfile: false },
  ])(
    "preserves native profile policy with Git settings and $label environment",
    async ({ shellEnvironment, expectedProfile }) => {
      const config = await buildRequestConfig("resume", {
        config: { shell_environment_policy: { experimental_use_profile: true } },
        shellEnvironment,
        shellGitConfigParameters: "'maintenance.auto=false' 'gc.auto=0'",
      });
      expect(config?.shell_environment_policy).toMatchObject({
        experimental_use_profile: expectedProfile,
      });
    },
  );

  it("admits host values through case-insensitive restrictive filters", async () => {
    const options = {
      config: {
        allow_login_shell: false,
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
        PATH: "/host-tools:/usr/bin",
        Path: "/host-tools:/usr/bin",
        GH_CONFIG_DIR: "/host-selected",
        GH_TOKEN: "",
        PREVIEW_SERVICE_TOKEN: "",
      },
      disableLoginShell: true,
    };
    const config = await buildRequestConfig("start", options);

    expect(config?.shell_environment_policy).toMatchObject({
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
    const policy = config?.shell_environment_policy;
    expect(isJsonObject(policy) && Object.keys(policy.filters ?? {})).toHaveLength(6);
    expect(config?.shell_environment_policy).not.toHaveProperty("include_only");
  });
});
