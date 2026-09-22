import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import * as service from "./computer-use-service.js";
import * as desktopPaths from "./desktop-app-paths.js";
import { createCodexDesktopGenerationOwner } from "./desktop-generation-owner.js";
import * as generation from "./desktop-generation.js";
import { isJsonObject } from "./protocol.js";
import {
  clearSharedCodexAppServerClientAndWait,
  createIsolatedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const ensureService = service.ensureCodexComputerUseServiceApp;
const resolveServiceSource = service.resolveCodexComputerUseServiceAppSourcePath;
type InspectService = NonNullable<Parameters<typeof ensureService>[0]["inspectServiceApp"]>;
const CLIENT_PATH = path.join(
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
);

describe.each(["service", "cache"])("createIsolatedCodexAppServerClient %s refresh", (artifact) => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(async () => {
    await clearSharedCodexAppServerClientAndWait();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "settles copy notifications before startup (desktop changed: %s)",
    async (desktopChanged) => {
      const root = tempDirs.make("openclaw-computer-use-startup-");
      const agentDir = path.join(root, "agent");
      const codexHome = path.join(agentDir, "codex-home");
      const appBundlePath = path.join(root, "ChatGPT.app");
      const command = path.join(appBundlePath, "codex");
      const sourceService = path.join(appBundlePath, "Codex Computer Use.app");
      const targetService = path.join(codexHome, "computer-use", "Codex Computer Use.app");
      const marketplace = path.join(appBundlePath, "plugins", "openai-bundled");
      const pluginRoot = path.join(marketplace, "plugins", "computer-use");
      const cachePath = path.join(
        codexHome,
        "plugins",
        "cache",
        "openai-bundled",
        "computer-use",
        "1.0.857",
      );
      const priorService = artifact === "service" ? "old-service" : "new-service";
      await writeServiceFixture(sourceService, "new-service");
      await writeServiceFixture(targetService, priorService);
      const sourceIdentity = await inspectServiceFixture(sourceService);
      const priorIdentity = await inspectServiceFixture(targetService);
      await fs.mkdir(path.join(marketplace, ".agents", "plugins"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(marketplace, ".agents", "plugins", "marketplace.json"),
        JSON.stringify({ name: "openai-bundled", plugins: [{ name: "computer-use" }] }),
      );
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "computer-use", version: "1.0.857" }),
      );
      await fs.writeFile(path.join(pluginRoot, "generation.txt"), "new-cache");
      await fs.cp(pluginRoot, cachePath, { recursive: true });
      await fs.writeFile(path.join(cachePath, "generation.txt"), "old-cache");

      vi.spyOn(desktopPaths, "resolveMacOSDesktopCodexAppPathCandidates").mockReturnValue([
        {
          appName: "ChatGPT.app",
          appBundlePath,
          appServerCommandPath: command,
          bundledMarketplacePath: marketplace,
          computerUseServiceAppPaths: [sourceService],
        },
      ]);
      vi.spyOn(service, "resolveCodexComputerUseServiceAppSourcePath").mockImplementation(
        (params) =>
          resolveServiceSource({
            ...params,
            platform: "darwin",
            inspectServiceApp: inspectServiceFixture,
          }),
      );
      vi.spyOn(service, "ensureCodexComputerUseServiceApp").mockImplementation((params) =>
        ensureService({
          ...params,
          platform: "darwin",
          inspectServiceApp: inspectServiceFixture,
          copyServiceApp: (source, target) => fs.cp(source, target, { recursive: true }),
        }),
      );

      const selected = { epoch: 1, fingerprint: "desktop-original" };
      let fingerprint = selected.fingerprint;
      const owner = createCodexDesktopGenerationOwner({
        initialGeneration: selected,
        readFingerprint: async () => {
          await expect(
            fs.readFile(path.join(targetService, "Contents", "Info.plist"), "utf8"),
          ).resolves.toBe(priorService);
          await expect(fs.readFile(path.join(cachePath, "generation.txt"), "utf8")).resolves.toBe(
            "old-cache",
          );
          return fingerprint;
        },
      });
      vi.spyOn(generation, "waitForCodexDesktopGeneration").mockImplementation(() => owner.wait());
      vi.spyOn(generation, "isCodexDesktopGenerationCurrent").mockImplementation(owner.isCurrent);
      const copy = fs.cp.bind(fs);
      vi.spyOn(fs, "cp").mockImplementation(async (...args) => {
        await copy(...args);
        if (args[0] === (artifact === "service" ? sourceService : pluginRoot)) {
          if (desktopChanged) {
            fingerprint = "desktop-replaced";
          }
          owner.markDirty();
        }
      });

      let initializations = 0;
      const harness = createClientHarness({
        onWrite(line, send) {
          const request: unknown = JSON.parse(line);
          if (
            isJsonObject(request) &&
            request.id !== undefined &&
            request.method === "initialize"
          ) {
            initializations += 1;
            send({
              id: request.id,
              result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
            });
          }
        },
      });
      const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      try {
        const startup = createIsolatedCodexAppServerClient({
          agentDir,
          authProfileId: null,
          startOptions: {
            transport: "stdio",
            homeScope: "agent",
            commandSource: "resolved-managed",
            command,
            args: ["app-server"],
            headers: {},
          },
          pluginConfig: {
            computerUse: { enabled: true, autoInstall: true, pluginCacheMode: "shared" },
          },
        });
        if (desktopChanged) {
          await expect(startup).rejects.toMatchObject({
            code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
          });
          expect(start).not.toHaveBeenCalled();
        } else {
          await expect(startup).resolves.toBe(harness.client);
          expect(start).toHaveBeenCalledOnce();
        }
        expect(initializations).toBe(desktopChanged ? 0 : 1);
        expect(owner.isCurrent(selected)).toBe(!desktopChanged);
        await expect(inspectServiceFixture(targetService)).resolves.toEqual(
          desktopChanged ? priorIdentity : sourceIdentity,
        );
        await expect(fs.readFile(path.join(cachePath, "generation.txt"), "utf8")).resolves.toBe(
          desktopChanged ? "old-cache" : "new-cache",
        );
        expect(await fs.readdir(path.dirname(targetService))).toEqual(["Codex Computer Use.app"]);
        expect(await fs.readdir(path.dirname(cachePath))).toEqual(["1.0.857"]);
      } finally {
        owner.stop();
        await harness.client.closeAndWait();
      }
    },
  );
});

async function writeServiceFixture(appPath: string, identity: string): Promise<void> {
  const clientPath = path.join(appPath, CLIENT_PATH);
  await fs.mkdir(path.dirname(clientPath), { recursive: true });
  await fs.writeFile(clientPath, "client", { mode: 0o755 });
  await fs.writeFile(path.join(appPath, "Contents", "Info.plist"), identity);
}

const inspectServiceFixture: InspectService = async (appPath) => {
  const info = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(info)) {
    return undefined;
  }
  const identity = await fs.readFile(info, "utf8");
  return {
    bundleId: "com.openai.sky.CUAService",
    teamId: "2DC432GLL2",
    clientBundleId: "com.openai.sky.CUAService.cli",
    clientTeamId: "2DC432GLL2",
    version: identity,
    build: identity,
    cdHash: `${identity}-service`,
    clientCdHash: `${identity}-client`,
  };
};
