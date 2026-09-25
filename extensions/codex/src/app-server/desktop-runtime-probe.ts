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
import {
  assertCodexDesktopComputerUseProbeSupported,
  resolveCodexComputerUseNodeReplStartArgs,
} from "./computer-use-node-repl.js";
import { ensureCodexComputerUseServiceApp } from "./computer-use-service.js";
import { readCodexComputerUseStatus } from "./computer-use.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";
import { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
import { listAllCodexAppServerModels } from "./models.js";
import type { CodexAppServerScopedRequest } from "./request.js";

export type CodexDesktopRuntimeProbeAgent = {
  model: string;
  codexHome: string;
  computerUse: ResolvedCodexComputerUseConfig;
  requiresComputerUse: boolean;
  startArgs?: string[];
  selectedAppServerCommand?: string;
};

type ProbeParams = {
  appBundlePath: string;
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
  const root = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-probe-"),
  );
  let cleanupConfirmed = true;
  try {
    for (const agent of params.agents) {
      assertCurrent();
      const home = await fs.mkdtemp(path.join(root, "home-"));
      const template = resolveMacOSDesktopCodexAppPathCandidates("darwin").find(
        (candidate) => candidate.appName === path.basename(params.appBundlePath),
      );
      if (!template) {
        throw new Error("Unsupported Codex desktop distribution.");
      }
      const relocate = (value: string) =>
        path.join(params.appBundlePath, path.relative(template.appBundlePath, value));
      const desktop = {
        ...template,
        appBundlePath: params.appBundlePath,
        appServerCommandPath: relocate(template.appServerCommandPath),
        bundledMarketplacePath: relocate(template.bundledMarketplacePath),
        computerUseServiceAppPaths: template.computerUseServiceAppPaths.map(relocate),
      };
      let marketplace: string | undefined;
      let args = ["app-server", "--listen", "stdio://"];
      if (agent.requiresComputerUse) {
        await assertCodexDesktopComputerUseProbeSupported({
          codexHome: agent.codexHome,
          args: agent.startArgs,
          enabled: agent.computerUse.enabled,
          appServerCommand: agent.selectedAppServerCommand ?? desktop.appServerCommandPath,
        });
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
        const pluginSource = path.join(desktop.bundledMarketplacePath, "plugins", "computer-use");
        if (!agent.computerUse.autoInstall) {
          await assertRetainedComputerUseSourceMatches(agent.codexHome, pluginSource);
          assertCurrent();
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
        await fs.cp(
          pluginSource,
          path.join(home, "plugins", "cache", "openai-bundled", "computer-use", manifest.version),
          { recursive: true },
        );
        const config = `[plugins."computer-use@openai-bundled"]\nenabled = true\n[marketplaces.openai-bundled]\nsource_type = "local"\nsource = ${JSON.stringify(marketplace)}\n`;
        await fs.writeFile(path.join(home, "config.toml"), config, { mode: 0o600 });
        args = await resolveCodexComputerUseNodeReplStartArgs({
          appServerCommand: desktop.appServerCommandPath,
          codexHome: home,
          codexConfigToml: config,
          args,
          enabled: true,
          serviceAppPath: service.targetPath,
          platform: "darwin",
        });
      }
      let client: CodexAppServerClient | undefined;
      const abort = () => client?.close();
      params.signal.addEventListener("abort", abort, { once: true });
      try {
        client = await CodexAppServerClient.start(
          {
            transport: "stdio",
            commandSource: "config",
            command: desktop.appServerCommandPath,
            args,
            cwd: home,
            env: { CODEX_HOME: home },
            clearEnv: Object.keys(process.env).filter((key) =>
              /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key),
            ),
          },
          assertCurrent,
        );
        assertCurrent();
        await client.initialize();
        assertCurrent();
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
        if (
          models.truncated ||
          !models.models.some((model) => model.id === agent.model || model.model === agent.model)
        ) {
          throw new Error(
            `Selected model ${agent.model} is missing from the candidate Codex metadata.`,
          );
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
              ...agent.computerUse,
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
        // Raw native clients are not SDK command children: explicitly join them before
        // deleting their private home or allowing artifact publication.
        if (client) {
          await closeProbeClient(client, root, () => {
            cleanupConfirmed = false;
          });
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
