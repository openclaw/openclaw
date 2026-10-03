/** Candidate validation uses disposable native state: no credentials, inference, or desktop input. */
import fs from "node:fs/promises";
import path from "node:path";
import {
  commandProcessCleanup,
  withCommandProcessScope,
} from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { parse as parseToml } from "smol-toml";
import { CodexAppServerClient } from "./client.js";
import { ensureCodexManagedBundledMarketplace } from "./computer-use-marketplace.js";
import { startCodexComputerUseProbeService } from "./computer-use-probe-service.js";
import { ensureCodexComputerUseServiceApp } from "./computer-use-service.js";
import {
  publishCodexUnifiedComputerUsePlugin,
  resolveManagedCodexComputerUseConfig,
} from "./computer-use-unified.js";
import { readCodexComputerUseStatus } from "./computer-use.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";
import { findMacOSDesktopCodexExecutable } from "./desktop-app-layout.js";
import { assertCodexDesktopComputerUseProbeSupported } from "./desktop-computer-use-policy.js";
import { listAllCodexAppServerModels } from "./models.js";
import type { CodexAppServerScopedRequest } from "./request.js";

export type CodexDesktopRuntimeProbeAgent = {
  models: readonly string[];
  codexHome: string;
  computerUse: ResolvedCodexComputerUseConfig;
  requiresComputerUse: boolean;
  startArgs?: string[];
  selectedAppServerCommand?: string;
};

type ProbeParams = {
  appBundlePath?: string;
  command?: string;
  expectedVersion?: string;
  agents: readonly CodexDesktopRuntimeProbeAgent[];
  signal: AbortSignal;
  assertCurrent: () => void;
};

export async function probeCodexDesktopRuntime(params: ProbeParams): Promise<void> {
  // Preserve unsettled native work in the enclosing maintenance scope even when
  // the health runner converts a check failure into a diagnostic.
  await withCommandProcessScope(() => probeCandidate(params), params.signal);
}

async function probeCandidate(params: ProbeParams): Promise<void> {
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-probe-")),
  );
  let cleanupConfirmed = true;
  try {
    for (const agent of params.agents) {
      assertCurrent();
      const home = await fs.mkdtemp(path.join(root, "home-"));
      const desktop = params.appBundlePath
        ? findMacOSDesktopCodexExecutable(params.appBundlePath)
        : undefined;
      const command = params.command ?? desktop?.appServerCommandPath;
      if (!command || (params.appBundlePath && !desktop)) {
        throw new Error("Unsupported Codex runtime or executable layout.");
      }
      const clearEnv = Object.keys(process.env).filter((key) =>
        /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key),
      );
      const env = { CODEX_HOME: home, HOME: home, USERPROFILE: home };
      let marketplace: string | undefined;
      let serviceAppPath: string | undefined;
      let probePlugin: { source: string; target: string } | undefined;
      const args = ["app-server", "--listen", "stdio://"];
      let computerUse = agent.computerUse;
      if (agent.requiresComputerUse) {
        if (!desktop) {
          throw new Error(
            "Package CLI Computer Use requires a qualified desktop distribution; retained the selected runtime.",
          );
        }
        // A custom native integration has a different owner; never certify it with an
        // unrelated official fixture or silently replace its configuration.
        if (
          agent.computerUse.pluginName !== "computer-use" ||
          agent.computerUse.mcpServerName !== "computer-use" ||
          agent.computerUse.marketplaceSource ||
          agent.computerUse.marketplacePath ||
          (agent.computerUse.marketplaceName &&
            agent.computerUse.marketplaceName !== "openai-bundled")
        ) {
          throw new Error(
            "Selected Computer Use has a custom source; update and validate that integration explicitly.",
          );
        }
        marketplace = await ensureCodexManagedBundledMarketplace({
          codexHome: home,
          ownershipRoot: root,
          appServerCommand: desktop.appServerCommandPath,
          candidates: [desktop],
          ownershipCandidates: [desktop],
          assertCurrent,
        });
        if (!marketplace) {
          throw new Error("Candidate desktop has no official Computer Use marketplace.");
        }
        marketplace = await fs.realpath(marketplace);
        computerUse = await resolveManagedCodexComputerUseConfig(agent.computerUse, marketplace);
        await assertCodexDesktopComputerUseProbeSupported({
          codexHome: agent.codexHome,
          args: agent.startArgs,
          enabled: agent.computerUse.enabled,
          candidatePluginName: computerUse.pluginName,
          appServerCommand: agent.selectedAppServerCommand ?? desktop.appServerCommandPath,
        });
        if (
          computerUse.pluginName !== "unified-computer-use" ||
          computerUse.mcpServerName !== "cua_repl"
        ) {
          throw new Error(
            "Candidate Computer Use cannot be qualified through privately owned native IPC; retained the selected runtime.",
          );
        }
        const retainedPluginSource = path.join(
          desktop.bundledMarketplacePath,
          "plugins",
          "computer-use",
        );
        if (!agent.computerUse.autoInstall) {
          await assertRetainedComputerUseSourceMatches(agent.codexHome, retainedPluginSource);
          assertCurrent();
        }
        // autoInstall:false keeps its existing signed service; only the disposable
        // probe copy is written. The real home and auth remain untouched.
        const service = await ensureCodexComputerUseServiceApp({
          codexHome: home,
          ownershipRoot: root,
          platform: "darwin",
          sourceAppCandidates: agent.computerUse.autoInstall
            ? desktop.computerUseServiceAppPaths
            : [path.join(agent.codexHome, "computer-use", "Codex Computer Use.app")],
          assertCurrent,
        });
        if (!service.targetPath || service.status === "source_missing") {
          throw new Error(
            "No compatible signed Computer Use service is available for the selected policy.",
          );
        }
        serviceAppPath = service.targetPath;
        const pluginSource = path.join(marketplace, "plugins", computerUse.pluginName);
        const manifest: unknown = JSON.parse(
          await fs.readFile(path.join(pluginSource, ".codex-plugin", "plugin.json"), "utf8"),
        );
        if (
          !isRecord(manifest) ||
          typeof manifest.version !== "string" ||
          !/^[\w.-]+$/u.test(manifest.version) ||
          manifest.version === "." ||
          manifest.version === ".."
        ) {
          throw new Error("Candidate Computer Use plugin has an invalid version.");
        }
        assertCurrent();
        probePlugin = {
          source: pluginSource,
          target: path.join(
            home,
            "plugins",
            "cache",
            "openai-bundled",
            computerUse.pluginName,
            manifest.version,
          ),
        };
        const config = `[plugins."${computerUse.pluginName}@openai-bundled"]\nenabled = true\n[marketplaces.openai-bundled]\nsource_type = "local"\nsource = ${JSON.stringify(marketplace)}\n`;
        await fs.writeFile(path.join(home, "config.toml"), config, { mode: 0o600 });
      }
      let client: CodexAppServerClient | undefined;
      let nativeService: Awaited<ReturnType<typeof startCodexComputerUseProbeService>> | undefined;
      const abort = () => client?.close();
      params.signal.addEventListener("abort", abort, { once: true });
      try {
        if (serviceAppPath && probePlugin) {
          nativeService = await startCodexComputerUseProbeService({
            appPath: serviceAppPath,
            home,
            signal: params.signal,
            assertCurrent,
          });
          const mcp: unknown = JSON.parse(
            await fs.readFile(path.join(probePlugin.source, ".mcp.json"), "utf8"),
          );
          if (!isRecord(mcp) || !isRecord(mcp.mcpServers)) {
            throw new Error("Candidate native plugin has an invalid MCP configuration.");
          }
          const server = mcp.mcpServers[computerUse.mcpServerName];
          if (!isRecord(server) || !isRecord(server.env)) {
            throw new Error(
              "Candidate native plugin does not expose its managed service environment.",
            );
          }
          Object.assign(server.env, nativeService.env);
          assertCurrent();
          await publishCodexUnifiedComputerUsePlugin(probePlugin.target, {
            pluginRoot: probePlugin.source,
            mcp,
          });
        }
        client = await CodexAppServerClient.start(
          {
            transport: "stdio",
            commandSource: "resolved-managed",
            command,
            args,
            cwd: home,
            env,
            clearEnv,
          },
          assertCurrent,
          { signal: params.signal, ownership: "retained-tree" },
        );
        assertCurrent();
        await client.initialize();
        assertCurrent();
        if (params.expectedVersion && client.getServerVersion() !== params.expectedVersion) {
          throw new Error(
            "Candidate app-server version does not match its official package metadata.",
          );
        }
        const acquired = client;
        const models = await listAllCodexAppServerModels({
          includeHidden: true,
          request: async <T>({
            method,
            requestParams,
          }: Parameters<CodexAppServerScopedRequest>[0]) =>
            acquired.request<T>(method, requestParams, {
              signal: params.signal,
              assertCurrent,
              timeoutMs: 20_000,
            }),
        });
        if (models.truncated) {
          throw new Error("Candidate Codex model metadata is incomplete.");
        }
        for (const requiredModel of agent.models) {
          if (
            !models.models.some(
              (model) => model.id === requiredModel || model.model === requiredModel,
            )
          ) {
            throw new Error(
              `Selected model ${requiredModel} is missing from the candidate Codex metadata.`,
            );
          }
        }
        if (marketplace) {
          await client.request(
            "plugin/list",
            { cwds: [] },
            { signal: params.signal, assertCurrent, timeoutMs: 20_000 },
          );
          const status = await readCodexComputerUseStatus({
            client,
            signal: params.signal,
            assertCurrent,
            overrides: {
              ...computerUse,
              enabled: true,
              autoInstall: false,
              autoRepair: false,
              marketplacePath: path.join(marketplace, ".agents/plugins/marketplace.json"),
              marketplaceName: "openai-bundled",
            },
            defaultBundledMarketplacePath: marketplace,
            defaultBundledMarketplacePathCandidates: [marketplace],
          });
          assertCurrent();
          if (!status.ready || !status.liveTest.ok) {
            throw new Error(`Candidate Computer Use validation failed: ${status.message}`);
          }
        }
        assertCurrent();
      } finally {
        params.signal.removeEventListener("abort", abort);
        // Join the retained process-tree owner before deleting its private home or
        // allowing artifact publication; root exit alone is not settlement.
        try {
          if (client) {
            await closeProbeClient(client, root, () => {
              cleanupConfirmed = false;
            });
          }
        } finally {
          await nativeService?.close();
        }
      }
    }
  } catch (error) {
    if (commandProcessCleanup.isUncertain(error)) {
      cleanupConfirmed = false;
    }
    throw error;
  } finally {
    if (cleanupConfirmed) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

async function assertRetainedComputerUseSourceMatches(
  codexHome: string,
  candidatePlugin: string,
): Promise<void> {
  const configText = await fs
    .readFile(path.join(codexHome, "config.toml"), "utf8")
    .catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
  const config = parseToml(configText);
  const marketplace = isRecord(config.marketplaces)
    ? config.marketplaces["openai-bundled"]
    : undefined;
  const source =
    isRecord(marketplace) && marketplace.source_type === "local" ? marketplace.source : undefined;
  const [retainedPath, candidatePath] = await Promise.all([
    typeof source === "string"
      ? fs.realpath(path.join(source, "plugins", "computer-use")).catch(() => undefined)
      : undefined,
    fs.realpath(candidatePlugin).catch(() => undefined),
  ]);
  if (!retainedPath || retainedPath !== candidatePath) {
    throw new Error(
      "Computer Use autoInstall is disabled and its retained marketplace differs from the candidate plugin. Enable computerUse.autoInstall or update and validate the native integration explicitly; the selected desktop has not changed.",
    );
  }
}

async function closeProbeClient(
  client: CodexAppServerClient,
  root: string,
  retainProbeState: () => void,
): Promise<void> {
  try {
    const closed = await client.closeAndWait();
    if (closed.cleanup !== "closed") {
      throw new Error("Candidate native process cleanup was not confirmed.");
    }
  } catch (error) {
    retainProbeState();
    throw new commandProcessCleanup.Error({
      cause: new Error(`Candidate probe state retained at ${root}.`, { cause: error }),
    });
  }
}
