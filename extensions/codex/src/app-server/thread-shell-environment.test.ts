import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { buildThreadStartParams, buildThreadResumeParams } from "./thread-lifecycle.js";
import {
  createThreadRequestAppServerOptions as createAppServerOptions,
  createThreadRequestAttemptParams as createAttemptParams,
} from "./thread-lifecycle.test-fixtures.js";
import {
  applyCodexManagedShellEnvironment,
  mergeCodexNativeShellEnvironment,
} from "./thread-shell-environment.js";

describe("Codex managed shell environment", () => {
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

  it.each(["/native/bin", ""])(
    "respects platform PATH casing for native value %s",
    (nativePath) => {
      const result = applyCodexManagedShellEnvironment(
        { shell_environment_policy: { set: { PATH: nativePath } } },
        { Path: ["/tools", "/gateway/bin"].join(path.delimiter) },
        true,
        ["/tools"],
      );
      const merged = ["/tools", ...(nativePath ? [nativePath] : [])].join(path.delimiter);
      expect(result.shell_environment_policy).toMatchObject({
        set:
          process.platform === "win32"
            ? { PATH: merged, Path: merged }
            : { PATH: nativePath, Path: ["/tools", "/gateway/bin"].join(path.delimiter) },
      });
    },
  );

  it.each([
    { label: "native", nativePath: "/native/bin", expected: "/native/bin" },
    { label: "empty native", nativePath: "", expected: "" },
    { label: "inherited", expected: "/gateway/bin" },
    {
      label: "request",
      nativePath: "/native/bin",
      requestPath: "/request/bin",
      expected: "/request/bin",
    },
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
    ({ action, inherit }) => {
      const options = {
        appServer: createAppServerOptions() as never,
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
      const request =
        action === "start"
          ? buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              cwd: "/repo",
              dynamicTools: [],
            })
          : buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              threadId: "thread-1",
            });

      const shellEnvironmentPolicy = request.config?.shell_environment_policy;
      if (!isJsonObject(shellEnvironmentPolicy)) {
        throw new Error("expected shell environment policy");
      }
      expect(shellEnvironmentPolicy).toMatchObject({
        inherit,
        experimental_use_profile: false,
        exclude: ["GIT_*"],
        set: {
          PATH: ["/host-tools", "/user-selected/bin"].join(path.delimiter),
          GH_CONFIG_DIR: "/host-selected",
          KEEP_ME: "yes",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
          OPENCLAW_STATE_DIR: "/fixture/diagnosed",
          OPENCLAW_CONFIG_PATH: "/fixture/custom.json",
          OPENCLAW_WORKSPACE_DIR: "/fixture/default-workspace",
        },
      });
      expect(request.config?.allow_login_shell).toBe(false);
      const includeOnly = shellEnvironmentPolicy.include_only;
      expect(includeOnly).toHaveLength(8);
      expect(includeOnly).toEqual(
        expect.arrayContaining([
          "PATH",
          "GH_CONFIG_DIR",
          "GITHUB_TOKEN",
          "GH_TOKEN",
          "PREVIEW_SERVICE_TOKEN",
          "OPENCLAW_STATE_DIR",
          "OPENCLAW_CONFIG_PATH",
          "OPENCLAW_WORKSPACE_DIR",
        ]),
      );
      expect(shellEnvironmentPolicy.experimental_use_profile).toBe(false);
      expect(shellEnvironmentPolicy).not.toHaveProperty("use_profile");
    },
  );

  it.each(["start", "resume"] as const)(
    "disables login profiles only for protected thread/%s environments",
    (action) => {
      const build = (
        config: JsonObject,
        shellEnvironment?: Readonly<Record<string, string>>,
        disableLoginShell?: boolean,
      ) => {
        const options = {
          appServer: createAppServerOptions() as never,
          config,
          shellEnvironment,
          disableLoginShell,
        };
        return action === "start"
          ? buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              cwd: "/repo",
              dynamicTools: [],
            })
          : buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              threadId: "thread-1",
            });
      };

      expect(build({ allow_login_shell: true }).config?.allow_login_shell).toBe(true);
      expect(build({}).config).not.toHaveProperty("allow_login_shell");
      expect(build({}, { GH_TOKEN: "", GITHUB_TOKEN: "" }).config).not.toHaveProperty(
        "allow_login_shell",
      );
      expect(build({}, { GH_TOKEN: "", GITHUB_TOKEN: "" }, true).config?.allow_login_shell).toBe(
        false,
      );
    },
  );

  it.each(["start", "resume"] as const)(
    "admits host values through case-insensitive restrictive filters for thread/%s",
    (action) => {
      const options = {
        appServer: createAppServerOptions() as never,
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
      const request =
        action === "start"
          ? buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              cwd: "/repo",
              dynamicTools: [],
            })
          : buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              threadId: "thread-1",
            });

      expect(request.config?.shell_environment_policy).toMatchObject({
        experimental_use_profile: false,
        set: {
          KEEP_ME: "yes",
          PATH: "/host-tools:/usr/bin",
          Path: "/host-tools:/usr/bin",
          GH_CONFIG_DIR: "/host-selected",
          GH_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
        },
        filters: {
          KEEP_ME: "include",
          "GIT_*": "exclude",
          path: "include",
          gh_config_dir: "include",
          gh_token: "include",
          preview_service_token: "include",
        },
      });
      const policy = request.config?.shell_environment_policy;
      expect(isJsonObject(policy) && Object.keys(policy.filters ?? {})).toHaveLength(6);
      expect(request.config?.shell_environment_policy).not.toHaveProperty("include_only");
    },
  );
});
