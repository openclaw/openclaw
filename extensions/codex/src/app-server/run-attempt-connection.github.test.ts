import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { prepareCodexAttemptRuntime } from "./run-attempt-runtime.js";
import { createParams, setupRunAttemptTestHooks, tempDir } from "./run-attempt-test-harness.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import { applyCodexManagedShellEnvironment } from "./thread-shell-environment.js";

setupRunAttemptTestHooks();

describe("Codex native GitHub credential binding", () => {
  it("does not issue local GitHub credentials across sequential incognito runs", async () => {
    const prepare = vi.fn(async () => {
      throw new Error("Incognito must not request a grant");
    });
    for (let turn = 0; turn < 2; turn++) {
      const params = createParams(
        path.join(tempDir, "incognito-github.jsonl"),
        path.join(tempDir, "incognito-github"),
        {
          sessionKey: "agent:main:dashboard:incognito-github-test",
          runId: `incognito-github-${turn}`,
        },
      );
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareLocalCommandEnvironment: prepare,
      };
      const connection = await prepareCodexAttemptConnection({
        params,
        options: { bindingStore: testCodexAppServerBindingStore },
      });
      try {
        await prepareCodexAttemptRuntime(connection);
        expect(connection.localGitHubInstructions).toBeUndefined();
        await connection.releaseLocalGitHub();
      } finally {
        connection.cancellation.dispose();
        connection.releaseModelExecution();
      }
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("projects the local run GitHub profile only into native command policy and finalizes it", async () => {
    const dispose = vi.fn(async () => {});
    const env = {
      GH_CONFIG_DIR: "/private/run/github",
      GH_HOST: "fixture.ghe.com",
      GH_TOKEN: "",
      GH_ENTERPRISE_TOKEN: "",
      GITHUB_TOKEN: "",
      GITHUB_ENTERPRISE_TOKEN: "",
      OPENCLAW_GATEWAY_PASSWORD: "",
      GITHUB_APP_PRIVATE_KEY: "",
      GITHUB_USER_LOGIN: "verified-person",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    };
    const prepare = vi.fn().mockResolvedValue({
      env,
      dispose,
      assertCurrent: () => {},
      instructions: "fixture identity context",
    });
    const params = createParams(
      path.join(tempDir, "github-local.jsonl"),
      path.join(tempDir, "github-local"),
    );
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareLocalCommandEnvironment: prepare,
    };
    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });
    try {
      await prepareCodexAttemptRuntime(connection);
      expect(prepare).toHaveBeenCalledOnce();
      expect(connection.shellEnvironment).toMatchObject(env);
      expect(connection.appServer.start.env ?? {}).not.toHaveProperty(
        "GH_CONFIG_DIR",
        env.GH_CONFIG_DIR,
      );
      expect(connection.appServer.start.env ?? {}).not.toHaveProperty("GITHUB_USER_LOGIN");
      const policy = applyCodexManagedShellEnvironment(
        { shell_environment_policy: { set: { GH_CONFIG_DIR: "/stale", GH_TOKEN: "stale" } } },
        connection.shellEnvironment,
        connection.disableLoginShell,
      );
      expect(policy).toMatchObject({
        allow_login_shell: false,
        shell_environment_policy: { set: env },
      });
      await connection.releaseLocalGitHub();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      connection.cancellation.dispose();
      connection.releaseModelExecution();
    }
  });
});
