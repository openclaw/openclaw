import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexCatalogHomeResolver } from "../session-catalog-homes.js";
import { resolveCodexAppServerHomeDir as homeDir } from "./auth-start-options.js";
import {
  requireCodexSupervisionModelSelection as selectModel,
  resolveCodexBindingAppServerConnection as resolveConnection,
  type CodexBindingAppServerConnectionParams,
} from "./binding-connection.js";
import {
  resolveCodexSupervisionAppServerRuntimeOptions as supervisionOptions,
  type CodexPluginConfig,
} from "./config.js";
import { buildCodexAppServerConnectionFingerprint as fingerprint } from "./plugin-app-cache-key.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const defaults = { env: {}, requirementsToml: null };
const connect = (params: CodexBindingAppServerConnectionParams) =>
  resolveConnection({ ...defaults, ...params });
const supervisedConfig = (enabled = true, port?: number): CodexPluginConfig => ({
  supervision: { enabled },
  ...(port ? { appServer: { transport: "websocket", url: `ws://127.0.0.1:${port}` } } : {}),
});
function supervisedBinding(pluginConfig: CodexPluginConfig, agentDir?: string) {
  return {
    connectionScope: "supervision" as const,
    appServerRuntimeFingerprint: fingerprint(
      supervisionOptions({ ...defaults, pluginConfig }),
      agentDir,
    ),
  };
}

describe("Codex binding app-server connection", () => {
  it.each(["agent", "user", "supervision"] as const)(
    "preserves %s-home auth ownership",
    async (scope) => {
      const supervised = scope === "supervision";
      const homeScope = supervised ? "user" : scope;
      const pluginConfig = supervised ? supervisedConfig() : { appServer: { homeScope } };
      const connection = await connect({
        binding: supervised ? supervisedBinding(pluginConfig) : {},
        authProfileId: "openai:work",
        pluginConfig,
      });
      expect(connection).toMatchObject({
        appServer: { start: { homeScope } },
        usesSupervisionConnection: supervised,
        requestAuthProfileId: supervised ? undefined : "openai:work",
        clientAuthProfileId: homeScope === "user" ? null : "openai:work",
      });
    },
  );

  it.each(["agent", "user"] as const)(
    "recovers the exact secondary Codex home with configured %s scope before browsing after restart",
    async (homeScope) => {
      const root = await fs.realpath(tempDirs.make("openclaw-codex-binding-home-"));
      const alphaAgentDir = path.join(root, "agents/alpha/agent");
      const betaAgentDir = path.join(root, "agents/beta/agent");
      const processCodexHome = path.join(root, "process-codex-home");
      const alphaCodexHome = homeDir(alphaAgentDir);
      await Promise.all(
        [processCodexHome, alphaCodexHome, homeDir(betaAgentDir)].map((dir) =>
          fs.mkdir(dir, { recursive: true }),
        ),
      );
      const config = {
        agents: {
          ownership: "explicit",
          entries: { alpha: { agentDir: alphaAgentDir }, beta: { agentDir: betaAgentDir } },
        },
      } as OpenClawConfig;
      const pluginConfig = { ...supervisedConfig(), appServer: { homeScope } };
      const env = { ...process.env, CODEX_HOME: processCodexHome };
      const registerCatalog = () =>
        createCodexCatalogHomeResolver({
          resolveRuntimeOptions: supervisionOptions,
          config,
          getRuntimeConfig: () => config,
          getPluginConfig: () => pluginConfig,
          env,
        });
      const homes = await registerCatalog().forAgent("beta");
      const source = homes.find((home) => home.appServer.start.env?.CODEX_HOME === alphaCodexHome);
      expect(source).toBeDefined();
      const persistedFingerprint = fingerprint(source!.appServer, betaAgentDir);
      // Recovery must not depend on warming the fresh plugin's catalog.
      registerCatalog();
      const connection = await connect({
        binding: {
          connectionScope: "supervision",
          appServerRuntimeFingerprint: persistedFingerprint,
        },
        pluginConfig,
        config,
        agentDir: betaAgentDir,
        env,
      });
      expect(connection).toMatchObject({
        appServer: {
          start: {
            homeScope: source!.appServer.start.homeScope,
            env: { CODEX_HOME: alphaCodexHome },
          },
        },
        clientAuthProfileId: null,
      });
      expect(fingerprint(connection.appServer, betaAgentDir)).toBe(persistedFingerprint);
    },
  );

  it("requires the exact native model pair for materialized supervised requests", () => {
    const select = (modelProvider?: string) =>
      selectModel({ connectionScope: "supervision", model: " gpt-5.5 ", modelProvider });
    expect(select(" openai ")).toEqual({ model: "gpt-5.5", modelProvider: "openai" });
    expect(() => select()).toThrow("missing its native model and provider");
  });

  it.each(["disabled", "changed"] as const)(
    "fails closed when supervision is %s",
    async (failure) => {
      const binding = supervisedBinding(supervisedConfig(true, 4500));
      const pluginConfig =
        failure === "disabled" ? supervisedConfig(false) : supervisedConfig(true, 4600);
      await expect(connect({ binding, pluginConfig })).rejects.toThrow(
        failure === "disabled" ? "Codex supervision is disabled" : "supervision connection changed",
      );
    },
  );
});
