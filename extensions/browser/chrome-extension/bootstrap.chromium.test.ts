import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chromeProductRoots,
  installChromeExtensionBootstrap,
  stableChromeExtensionDir,
} from "../src/browser/extension-install-fixture.test-support.js";
import { generateChromeExtensionIdForPath } from "../src/browser/extension-install-layout.js";
import { useNativeHostLaunchFixture } from "../src/browser/extension-install.test-support.js";
import { getGatewayExtensionRelayModule } from "../src/browser/extension-relay.runtime.js";
import { DEFAULT_UPLOAD_DIR } from "../src/browser/paths.js";
import { getPageForTargetId } from "../src/browser/pw-session.js";
import {
  createBrowserRouteDispatcher,
  type BrowserDispatchRequest,
  type BrowserDispatchResponse,
} from "../src/browser/routes/dispatcher.js";
import { createBrowserRouteContext } from "../src/browser/server-context.js";
import { getFreePort } from "../src/browser/test-port.js";
import { getBrowserControlState, stopBrowserControlService } from "../src/control-service.js";
import { createBootstrapDiagnostic } from "./bootstrap-diagnostics.test-support.js";
import { proveLabeledRefScreenshot } from "./labeled-screenshot.test-support.js";
import chromeExtensionManifest from "./manifest.json" with { type: "json" };
import { holdNavigationAccessCheck } from "./navigation-race.test-support.js";
import { relayTestKey } from "./relay-key.test-support.js";
import { assertRelayTabCreation } from "./tab-creation.test-support.js";

declare const chrome: {
  runtime: { sendMessage: (message: unknown) => Promise<Record<string, unknown>> };
};

const runE2E =
  process.env.OPENCLAW_BROWSER_EXTENSION_E2E === "1" &&
  (process.platform === "linux" || process.platform === "darwin");
const cleanups: Array<() => Promise<void>> = [];
const STORE_ORIGIN = "chrome-extension://kcdjddhmeafeomebliikmbpblkmkfoig/";
const nativeHostFixture = useNativeHostLaunchFixture();
type Tab = { tabId?: string; targetId?: string; url?: string; webExtensionTabId?: number };

// The in-process dispatcher erases the registered /tabs response type.
const responseTabs = (response: BrowserDispatchResponse) =>
  (response.body as { tabs?: Tab[] }).tabs;
const expectSuccess = (response: BrowserDispatchResponse) =>
  expect(response.status, JSON.stringify(response.body)).toBe(200);
const sendExtensionMessage = (page: Page, message: Record<string, unknown>) =>
  page.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
const expectDoctorCheck = (response: BrowserDispatchResponse, check: Record<string, unknown>) => {
  expectSuccess(response);
  expect(response.body).toMatchObject({
    checks: expect.arrayContaining([expect.objectContaining(check)]),
  });
};
const writePrivateJson = (file: string, value: unknown) =>
  fs.writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const waitUntil = (read: () => boolean | Promise<boolean>, timeout?: number) =>
  expect.poll(read, { timeout }).toBe(true);
function required<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup().catch(() => undefined);
  }
});

async function waitForExtensionId(context: BrowserContext, extensionPath: string): Promise<string> {
  const browser = required(context.browser(), "Chromium browser connection unavailable");
  const cdp = await browser.newBrowserCDPSession();
  const expected = await fs.realpath(extensionPath);
  const deadline = Date.now() + 15_000;
  do {
    const result = (await cdp.send("Extensions.getExtensions")) as {
      extensions: Array<{ id: string; path: string }>;
    };
    for (const extension of result.extensions) {
      if (
        (await fs.realpath(extension.path).catch(() => path.resolve(extension.path))) === expected
      ) {
        return extension.id;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  } while (Date.now() < deadline);
  throw new Error("Chromium did not report the loaded OpenClaw extension");
}

async function loadUnpackedExtension(
  context: BrowserContext,
  extensionPath: string,
): Promise<void> {
  const browser = required(context.browser(), "Chromium browser connection unavailable");
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Extensions.loadUnpacked", { path: extensionPath });
}

async function assertOwnedManifests(
  manifestPaths: string[],
  expectedOrigins: string[],
): Promise<void> {
  expect(manifestPaths.length).toBeGreaterThan(0);
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      name?: unknown;
      path?: unknown;
      allowed_origins?: unknown;
      key?: unknown;
    };
    expect(manifest.name).toBe("ai.openclaw.browser_bootstrap");
    expect(Object.hasOwn(manifest, "key")).toBe(false);
    expect(manifest.allowed_origins).toEqual(expectedOrigins);
    if (typeof manifest.path !== "string") {
      throw new Error("Native manifest path missing");
    }
    expect(await fs.readFile(manifest.path, "utf8")).toContain(
      "# OpenClaw native messaging bootstrap v1",
    );
  }
}

async function seedLinuxSecurePreferences(params: {
  userDataDir: string;
  extensionId: string;
  extensionPath: string;
}): Promise<void> {
  const profileDir = path.join(params.userDataDir, "Default");
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writePrivateJson(path.join(profileDir, "Secure Preferences"), {
    extensions: {
      settings: {
        [params.extensionId]: { location: 4, path: params.extensionPath },
      },
    },
  });
}

function decodeSingleNativeResponse(frame: Buffer): Record<string, unknown> {
  expect(frame.length, "native host response header").toBeGreaterThanOrEqual(4);
  const length = os.endianness() === "LE" ? frame.readUInt32LE() : frame.readUInt32BE();
  expect(frame, "exactly one native host response frame").toHaveLength(length + 4);
  const parsed: unknown = JSON.parse(frame.subarray(4).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("native host returned an invalid response payload");
  }
  return parsed as Record<string, unknown>;
}

describe.runIf(runE2E)("Chrome native bootstrap Chromium E2E", () => {
  it("pre-registers before the first native call, auto-pairs, and revokes a paused tab", async ({
    signal,
  }) => {
    const diagnostic = createBootstrapDiagnostic();
    cleanups.push(async () => {
      diagnostic.dispose();
      diagnostic.flush();
    });
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-extension-e2e-")),
    );
    const existingSessionProfile = "e2e-existing-session";
    cleanups.push(async () => await fs.rm(root, { recursive: true, force: true }));
    const homeDir = path.join(root, "home");
    const stateDir = path.join(root, "custom-state");
    const configPath = path.join(root, "custom-config", "openclaw.json");
    const gatewayPort = await getFreePort();
    const proofUrl = `http://127.0.0.1:${gatewayPort}/browser-owner-proof`;
    let relayPort = await getFreePort();
    while (relayPort === gatewayPort) {
      relayPort = await getFreePort();
    }
    const linuxConfigHome = path.join(homeDir, ".config");
    const chromeRootEnv =
      process.platform === "linux"
        ? { CHROME_CONFIG_HOME: linuxConfigHome, XDG_CONFIG_HOME: linuxConfigHome }
        : {};
    const userDataDir =
      process.platform === "darwin"
        ? path.join(homeDir, "Library", "Application Support", "Google", "Chrome for Testing")
        : path.join(linuxConfigHome, "chromium");
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const token = relayTestKey(3);
    await fs.writeFile(
      path.join(stateDir, "credentials", "browser-extension-relay.secret"),
      `${token}\n`,
      { mode: 0o600 },
    );
    await writePrivateJson(configPath, {
      gateway: { port: gatewayPort },
      browser: { profiles: { e2e: { driver: "extension", cdpPort: relayPort } } },
    });
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_PORT: String(gatewayPort),
      },
      async () => {
        const extensionSource = path.dirname(fileURLToPath(import.meta.url));
        // Match installation: Chrome launches the built host, not a fresh tsx
        // compilation of the source graph inside each bounded native request.
        const launchFixture = await nativeHostFixture(
          root,
          path.resolve("dist/extensions/browser/native-host-entry.js"),
        );
        const pluginRoot = path.join(root, "browser-plugin");
        await fs.mkdir(pluginRoot, { mode: 0o700 });
        const deps = {
          platform: process.platform,
          homeDir,
          stateDir,
          env: {
            HOME: homeDir,
            ...chromeRootEnv,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_GATEWAY_PORT: String(gatewayPort),
          },
          ...launchFixture,
        };
        const { handleGatewayExtensionUpgrade } = await getGatewayExtensionRelayModule();
        const gatewayServer = http.createServer((req, res) => {
          if (req.url === "/browser-owner-proof") {
            diagnostic.mark("http.request", true);
            res.once("finish", () => diagnostic.mark("http.finish", res.statusCode));
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<title>OpenClaw selected tab</title><h1>OpenClaw created destination</h1>");
            return;
          }
          res.writeHead(426);
          res.end();
        });
        let extensionTransport: Duplex | undefined;
        let extensionConnections = 0;
        gatewayServer.on("upgrade", (req, socket, head) => {
          extensionTransport = socket;
          extensionConnections += 1;
          void handleGatewayExtensionUpgrade(req, socket, head);
        });
        await new Promise<void>((resolve) => {
          gatewayServer.listen(gatewayPort, "127.0.0.1", resolve);
        });
        cleanups.push(
          async () =>
            await new Promise<void>((resolve) => {
              gatewayServer.close(() => {
                diagnostic.mark("http.closed", !gatewayServer.listening);
                resolve();
              });
            }),
        );
        cleanups.push(stopBrowserControlService);
        // Real Chrome/native children must not inherit Vitest's source overrides
        // or fast-test flags; the launcher owns the installation selectors.
        const browserEnv: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          // Chromium's macOS singleton sockets use this instead of TMPDIR.
          MAC_CHROMIUM_TMPDIR: process.env.TMPDIR,
          HOME: homeDir,
          ...chromeRootEnv,
        };

        const launchChromium = async () =>
          await chromium.launchPersistentContext(userDataDir, {
            channel: "chromium",
            headless: true,
            env: browserEnv,
            ignoreDefaultArgs: ["--disable-extensions"],
            args: ["--enable-unsafe-extension-debugging"],
          });
        let context = await launchChromium();
        cleanups.push(async () => await context.close());
        const installed = stableChromeExtensionDir(deps);
        const predictedId = generateChromeExtensionIdForPath(installed, process.platform);
        const expectedOrigins = [
          predictedId,
          generateChromeExtensionIdForPath(extensionSource, process.platform),
        ]
          .toSorted()
          .map((id) => `chrome-extension://${id}/`);
        expectedOrigins.push(STORE_ORIGIN);
        expectedOrigins.sort();
        const relevantManifestPaths = chromeProductRoots(deps)
          .filter((productRoot) => productRoot.userDataDir === userDataDir)
          .map((productRoot) =>
            path.join(productRoot.nativeManifestDir, "ai.openclaw.browser_bootstrap.json"),
          );
        const registered = Promise.withResolvers<void>();
        const installPromise = installChromeExtensionBootstrap({
          bundledDir: extensionSource,
          pluginRoot,
          waitMs: 15_000,
          deps,
          signal,
          onProgress: (message) => {
            if (message.startsWith("Native bootstrap is ready.")) {
              registered.resolve();
            }
          },
        });
        await withinTest(
          awaitGateBeforeSettlement(
            registered.promise,
            installPromise,
            "Native host pre-registration failed",
          ),
          signal,
        );
        await assertOwnedManifests(relevantManifestPaths, expectedOrigins);
        await loadUnpackedExtension(context, installed);
        const extensionId = await waitForExtensionId(context, installed);
        expect(extensionId).toBe(predictedId);
        await context.close();
        if (process.platform === "linux") {
          // Linux CDP loads are transient and omit the protected record written by Load unpacked.
          // Seed that exact record only after Chromium confirms the path-derived extension ID.
          await seedLinuxSecurePreferences({ userDataDir, extensionId, extensionPath: installed });
        }

        const status = await installPromise;
        expect(status.manualSetupRequired, JSON.stringify(status)).toBe(false);
        expect(
          status.discovered.some(
            (entry) => entry.extensionPath === installed && entry.extensionId === predictedId,
          ),
        ).toBe(true);
        context = await launchChromium();
        await loadUnpackedExtension(context, installed);
        expect(await waitForExtensionId(context, installed)).toBe(predictedId);
        const controlled = await context.newPage();
        await controlled.goto(
          `data:text/html,${encodeURIComponent(
            '<title>OpenClaw E2E</title><style>body{margin:0}#spacer{height:2200px}#target{display:block;width:240px;height:96px;background:#1457d9;color:white;border:0;font:20px sans-serif}</style><div id="spacer"></div><button id="target">Offscreen target</button>',
          )}`,
        );

        const extensionPage = await context.newPage();
        await extensionPage.goto(`chrome-extension://${extensionId}/options.html`);
        let extensionStatus: Record<string, unknown> = {};
        await waitUntil(async () => {
          extensionStatus = await sendExtensionMessage(extensionPage, { type: "getStatus" });
          return extensionStatus.paired === true;
        }, 15_000);
        expect(extensionStatus).toMatchObject({ paired: true, accessMode: "all" });
        await waitUntil(() => {
          const currentRelay = getBrowserControlState()?.extensionRelays?.get("e2e");
          return currentRelay?.ownership === "owned" && currentRelay.bridge.extensionConnected;
        }, 15_000);
        const relay = getBrowserControlState()?.extensionRelays?.get("e2e");
        if (!relay || relay.ownership !== "owned" || relay.port !== relayPort) {
          throw new Error("Gateway wakeup did not start the configured extension relay");
        }
        diagnostic.watchRelay(relay.bridge);
        let uploadPathHandoffs = 0;
        const attachCdpClientSocket = relay.bridge.attachCdpClientSocket.bind(relay.bridge);
        relay.bridge.attachCdpClientSocket = (socket) => {
          const handlers = attachCdpClientSocket(socket);
          return {
            onMessage: (raw) => {
              if (JSON.parse(raw).method === "DOM.setFileInputFiles") {
                uploadPathHandoffs += 1;
              }
              handlers.onMessage(raw);
            },
            onClose: handlers.onClose,
          };
        };
        const browserState = getBrowserControlState();
        const extensionProfile = browserState?.resolved.profiles.e2e;
        if (!browserState || !extensionProfile) {
          throw new Error("Browser E2E state did not contain the extension profile");
        }
        const relayAuthorization = `Basic ${Buffer.from(
          `openclaw-internal:${relay.internalToken}`,
        ).toString("base64")}`;
        const relayVersionResponse = await fetch(`http://127.0.0.1:${relay.port}/json/version`, {
          headers: { Authorization: relayAuthorization },
        });
        const relayVersion = (await relayVersionResponse.json()) as {
          webSocketDebuggerUrl?: string;
        };
        if (!relayVersion.webSocketDebuggerUrl) {
          throw new Error("Authenticated extension relay did not return a WebSocket endpoint");
        }
        browserState.resolved.profiles[existingSessionProfile] = {
          ...extensionProfile,
          driver: "existing-session",
          attachOnly: true,
          cdpUrl: `http://openclaw-internal:${encodeURIComponent(relay.internalToken)}@127.0.0.1:${relay.port}`,
          mcpArgs: [
            "--wsEndpoint",
            relayVersion.webSocketDebuggerUrl,
            "--wsHeaders",
            JSON.stringify({ Authorization: relayAuthorization }),
          ],
        };
        browserState.resolved.ssrfPolicy = undefined;
        const routeContext = createBrowserRouteContext({
          getState: () => browserState,
          refreshConfigFromDisk: false,
        });
        const dispatcher = createBrowserRouteDispatcher(routeContext);
        const dispatch = (route: string, body?: BrowserDispatchRequest["body"], profile = "e2e") =>
          dispatcher.dispatch({
            method: body === undefined ? "GET" : "POST",
            path: route,
            body,
            query: { profile },
          });
        const playwrightTabsResponse = await dispatch("/tabs");
        expectSuccess(playwrightTabsResponse);
        expect(playwrightTabsResponse.body).toMatchObject({ running: true });
        const matchingDoctor = await dispatch("/doctor");
        expectDoctorCheck(matchingDoctor, {
          id: "extension-version",
          status: "pass",
          summary: `running ${chromeExtensionManifest.version}; bundled ${chromeExtensionManifest.version} (match)`,
        });
        const uploadPage = await context.newPage();
        cleanups.push(async () => await uploadPage.close());
        await uploadPage.goto(proofUrl);
        await uploadPage.evaluate(() => {
          const input = document.createElement("input");
          input.type = "file";
          input.id = "upload";
          document.body.append(input);
        });
        const previousUploadPolicy = browserState.resolved.ssrfPolicy;
        browserState.resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: true };
        try {
          let uploadTargetId: string | undefined;
          await expect
            .poll(
              async () => {
                uploadTargetId = responseTabs(await dispatch("/tabs"))?.find(
                  (tab) => tab.url === uploadPage.url(),
                )?.targetId;
                return uploadTargetId;
              },
              { timeout: 15_000 },
            )
            .toBeTruthy();
          await fs.mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
          // 47 MiB accounts for base64 expansion and framing in a 64 MiB relay frame.
          for (const { size, pathHandoff } of [
            { size: 30, pathHandoff: false },
            { size: 46 * 1024 * 1024, pathHandoff: false },
            { size: 47 * 1024 * 1024, pathHandoff: true },
          ]) {
            const file = path.join(
              DEFAULT_UPLOAD_DIR,
              `extension-upload-${Date.now()}-${size}.bin`,
            );
            cleanups.push(async () => await fs.rm(file, { force: true }));
            await fs.writeFile(file, Buffer.alloc(size, 7));
            const before = uploadPathHandoffs;
            const response = await dispatch("/hooks/file-chooser", {
              targetId: uploadTargetId,
              element: "#upload",
              paths: [file],
            });
            expectSuccess(response);
            const received = await uploadPage
              .locator("#upload")
              .evaluate((input: HTMLInputElement) => {
                const receivedFile = input.files?.[0];
                return receivedFile ? { name: receivedFile.name, size: receivedFile.size } : null;
              });
            expect(received).toEqual({ name: path.basename(file), size });
            expect(uploadPathHandoffs - before).toBe(pathHandoff ? 1 : 0);
          }
        } finally {
          browserState.resolved.ssrfPolicy = previousUploadPolicy;
        }
        const findTarget = (response: BrowserDispatchResponse, url: string) =>
          required(
            responseTabs(response)?.find((tab) => tab.url === url)?.targetId || undefined,
            `Target missing for ${url}: ${JSON.stringify(response.body)}`,
          );
        const screenshot = (targetId: string, proofName: string) =>
          proveLabeledRefScreenshot({
            dispatcher,
            controlled,
            profile: existingSessionProfile,
            targetId,
            proofName,
          });
        const tabsResponse = await dispatch("/tabs", undefined, existingSessionProfile);
        const controlledTab = responseTabs(tabsResponse)?.find((tab) =>
          tab.url?.startsWith("data:text/html"),
        );
        if (!controlledTab?.targetId) {
          throw new Error(`Existing-session E2E tab missing: ${JSON.stringify(tabsResponse.body)}`);
        }
        await screenshot(controlledTab.targetId, "existing-session-offscreen-labeled-ref.png");

        const earlyPlaywrightTarget = findTarget(playwrightTabsResponse, controlled.url());
        await controlled.evaluate(() => {
          document.body.dataset.relayWaitStartedAt = String(Date.now());
        });
        const awaitedRuntimeWait = await dispatch("/act", {
          kind: "wait",
          targetId: earlyPlaywrightTarget,
          fn: "() => Date.now() - Number(document.body.dataset.relayWaitStartedAt) >= 17000",
          timeoutMs: 25_000,
        });
        expectSuccess(awaitedRuntimeWait);
        // Capture the existing context before the socket fault; target detachment keeps it alive.
        const connectOverCdp = vi.spyOn(chromium, "connectOverCDP");
        let relayPlaywrightContext: BrowserContext;
        try {
          const relayPage = await getPageForTargetId({
            cdpUrl: routeContext.forProfile("e2e").profile.cdpUrl,
            targetId: earlyPlaywrightTarget,
          });
          relayPlaywrightContext = relayPage.context();
          expect(connectOverCdp).not.toHaveBeenCalled();
          const bindingSession = await relayPlaywrightContext.newCDPSession(relayPage);
          const observerSession = await relayPlaywrightContext.newCDPSession(relayPage);
          const bindingName = "__openclawRelayBindingProof";
          const bindingPayloads: string[] = [];
          const observerPayloads: string[] = [];
          const collectBinding =
            (payloads: string[]) => (event: { name: string; payload: string }) => {
              if (event.name === bindingName) {
                payloads.push(event.payload);
              }
            };
          observerSession.on("Runtime.bindingCalled", collectBinding(observerPayloads));
          bindingSession.on("Runtime.bindingCalled", collectBinding(bindingPayloads));
          try {
            await observerSession.send("Runtime.enable");
            await bindingSession.send("Runtime.addBinding", { name: bindingName });
            await bindingSession.send("Runtime.evaluate", {
              expression: "globalThis.__openclawRelayBindingProof('before-enable')",
            });
            await expect.poll(() => bindingPayloads).toEqual(["before-enable"]);
            await bindingSession.send("Runtime.enable");
            await bindingSession.send("Runtime.disable");
            await bindingSession.send("Runtime.evaluate", {
              expression: "globalThis.__openclawRelayBindingProof('after-disable')",
            });
            await expect.poll(() => bindingPayloads).toEqual(["before-enable", "after-disable"]);
            expect(observerPayloads).toEqual([]);
          } finally {
            await bindingSession
              .send("Runtime.removeBinding", { name: bindingName })
              .catch(() => {});
            await bindingSession.detach().catch(() => {});
            await observerSession.detach().catch(() => {});
          }
        } finally {
          connectOverCdp.mockRestore();
        }

        expect(relay.bridge.cdpClientCount).toBeGreaterThanOrEqual(2);
        const previousConnections = extensionConnections;
        if (!extensionTransport) {
          throw new Error("Test-owned extension transport missing");
        }
        extensionTransport.destroy();
        await expect
          .poll(() => extensionConnections, { timeout: 15_000 })
          .toBeGreaterThan(previousConnections);
        await waitUntil(() => relay.bridge.extensionConnected);
        // Hello starts asynchronous reattachment; the MCP client's page inventory
        // becomes ready only after it receives the restored target.
        const reconnectedTarget = await vi.waitFor(async () => {
          const reconnectedTabsResponse = await dispatch(
            "/tabs",
            undefined,
            existingSessionProfile,
          );
          return findTarget(reconnectedTabsResponse, controlled.url());
        });
        await screenshot(
          reconnectedTarget,
          "existing-session-reconnected-offscreen-labeled-ref.png",
        );
        expect(relay.bridge.cdpClientCount).toBeGreaterThanOrEqual(2);

        const distractingUrl = `data:text/html,${encodeURIComponent("<title>Unrelated tab</title>")}`;
        diagnostic.arm(reconnectedTarget);
        const distractingPage = await context.newPage();
        await distractingPage.goto(distractingUrl);
        await waitUntil(() =>
          relayPlaywrightContext.pages().some((page) => page.url() === distractingUrl),
        );
        const liveTabsResponse = await dispatch("/tabs");
        const liveTabs = responseTabs(liveTabsResponse);
        const selectedTab = liveTabs?.find((tab) => tab.url === controlled.url());
        const unrelatedTab = liveTabs?.find((tab) => tab.url === distractingUrl);
        if (!selectedTab?.targetId || !unrelatedTab?.targetId) {
          throw new Error(
            `Extension navigation proof tabs missing: ${JSON.stringify(liveTabsResponse)}`,
          );
        }
        expect(selectedTab.targetId).not.toBe(unrelatedTab.targetId);
        const nativeSelectedTabId = relay.bridge
          .accessibleTabs()
          .find((tab) => tab.url === controlled.url())?.tabId;
        expect(nativeSelectedTabId).toBeTypeOf("number");
        expect(selectedTab.webExtensionTabId).toBe(nativeSelectedTabId);
        const previousSsrfPolicy = browserState.resolved.ssrfPolicy;
        browserState.resolved.ssrfPolicy = { allowPrivateNetwork: true };
        const extensionCdpUrl = routeContext.forProfile("e2e").profile.cdpUrl;
        diagnostic.arm(selectedTab.targetId, unrelatedTab.targetId);
        diagnostic.mark("relay.clients", relay.bridge.cdpClientCount);
        const selectedOwner = relay.bridge.captureOperationTarget(selectedTab.targetId);
        const unrelatedOwner = relay.bridge.captureOperationTarget(unrelatedTab.targetId);
        const actedPage = await getPageForTargetId({
          cdpUrl: extensionCdpUrl,
          targetId: selectedTab.targetId,
          ssrfPolicy: browserState.resolved.ssrfPolicy,
        });
        const detachedNavigation = vi.spyOn(actedPage, "goto").mockImplementationOnce(() => {
          diagnostic.mark("injection.used", true);
          return Promise.reject(new Error("page.goto: Frame has been detached"));
        });
        const worker = context
          .serviceWorkers()
          .find((entry) => entry.url().startsWith(`chrome-extension://${extensionId}/`));
        if (!worker) {
          throw new Error("Extension service worker missing");
        }
        const finishNavigationProbe = await holdNavigationAccessCheck(worker, proofUrl);
        let probe: Awaited<ReturnType<typeof finishNavigationProbe>>;
        try {
          const navigationResponse = await dispatch("/navigate", {
            targetId: selectedTab.targetId,
            url: proofUrl,
          });
          diagnostic.mark("navigate.status", navigationResponse.status);
          expectSuccess(navigationResponse);
          expect(navigationResponse.body).toMatchObject({
            ok: true,
            targetId: selectedTab.targetId,
            url: proofUrl,
          });
          expect(detachedNavigation).toHaveBeenCalledTimes(1);
          const recoveredPage = await getPageForTargetId({
            cdpUrl: extensionCdpUrl,
            targetId: selectedTab.targetId,
            ssrfPolicy: browserState.resolved.ssrfPolicy,
          });
          diagnostic.mark("adapter.fresh", recoveredPage !== actedPage);
          expect(recoveredPage).not.toBe(actedPage);
          expect(distractingPage.url()).toBe(distractingUrl);
        } finally {
          diagnostic.mark("injection.calls", detachedNavigation.mock.calls.length);
          diagnostic.mark("owner.selected", selectedOwner?.() === selectedTab.targetId);
          diagnostic.mark("owner.unrelated", unrelatedOwner?.() === unrelatedTab.targetId);
          diagnostic.mark("direct.url", controlled.url() === proofUrl);
          diagnostic.mark("unrelated.url", distractingPage.url() === distractingUrl);
          diagnostic.mark("relay.clients", relay.bridge.cdpClientCount);
          diagnostic.flush();
          detachedNavigation.mockRestore();
          browserState.resolved.ssrfPolicy = previousSsrfPolicy;
          probe = await finishNavigationProbe();
        }
        expect(probe.heldReads).toBeGreaterThan(0);
        expect(probe.sawLoad).toBe(true);

        const creationPolicy = browserState.resolved.ssrfPolicy;
        browserState.resolved.ssrfPolicy = {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        };
        try {
          for (const accessMode of ["all", "selected"] as const) {
            expect(
              await sendExtensionMessage(extensionPage, { type: "setAccessMode", accessMode }),
            ).toMatchObject({ ok: true });
            await assertRelayTabCreation({
              context,
              extensionPage,
              dispatcher,
              url: proofUrl,
              accessMode,
            });
          }
        } finally {
          await sendExtensionMessage(extensionPage, { type: "setAccessMode", accessMode: "all" });
          browserState.resolved.ssrfPolicy = creationPolicy;
        }

        const registration = status.registrations.find(
          (entry) => relevantManifestPaths.includes(entry.manifestPath) && entry.state === "owned",
        );
        if (!registration) {
          throw new Error("Active Chromium native host registration missing");
        }
        const manifest = JSON.parse(await fs.readFile(registration.manifestPath, "utf8")) as {
          path: string;
        };
        const requestBody = Buffer.from(
          JSON.stringify({ v: 1, op: "bootstrap", nonce: "BwcHBwcHBwcHBwcHBwcHBw" }),
        );
        const requestFrame = Buffer.alloc(requestBody.length + 4);
        requestFrame[os.endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE"](
          requestBody.length,
        );
        requestBody.copy(requestFrame, 4);
        const probeHost = (origin: string) => {
          const result = spawnSync(manifest.path, [origin], {
            input: requestFrame,
            env: browserEnv,
            timeout: 30_000,
          });
          expect(
            result.status,
            `native host origin=${origin} exit=${result.status} signal=${result.signal} stderr=${result.stderr.toString("utf8")}`,
          ).toBe(0);
          return decodeSingleNativeResponse(result.stdout);
        };
        const nativeResponse = probeHost(`chrome-extension://${extensionId}/`);
        expect(nativeResponse).toMatchObject({ ok: true, nonce: "BwcHBwcHBwcHBwcHBwcHBw" });
        const pairingString = nativeResponse.pairingString;
        if (typeof pairingString !== "string") {
          throw new Error("native host pairing string missing");
        }
        const fragmentAt = pairingString.lastIndexOf("#");
        expect(fragmentAt, "native host pairing fragment").toBeGreaterThanOrEqual(0);
        const relayUrl = new URL(pairingString.slice(0, fragmentAt));
        expect(relayUrl).toMatchObject({
          hostname: "127.0.0.1",
          port: String(gatewayPort),
          pathname: "/browser/extension",
        });
        expect(relayUrl.searchParams.get("gateway")).toBe(`ws://127.0.0.1:${gatewayPort}`);
        expect(pairingString.slice(fragmentAt + 1)).toBe(token);
        expect(probeHost(STORE_ORIGIN)).toMatchObject({
          ok: true,
          nonce: "BwcHBwcHBwcHBwcHBwcHBw",
        });

        await waitUntil(() =>
          relay.bridge.accessibleTabs().some((tab) => tab.url.startsWith("data:text/html")),
        );

        const tabId = relay.bridge
          .accessibleTabs()
          .find((tab) => tab.url.startsWith("data:text/html"))?.tabId;
        if (tabId === undefined) {
          throw new Error("Ungrouped E2E tab was not exposed in All tabs mode");
        }
        await sendExtensionMessage(extensionPage, {
          type: "toggleTabAccess",
          tabId,
          accessMode: "all",
          grant: false,
        });
        await expect
          .poll(() => relay.bridge.accessibleTabs().some((tab) => tab.tabId === tabId))
          .toBe(false);

        const installedManifestPath = path.join(installed, "manifest.json");
        const installedManifest = JSON.parse(await fs.readFile(installedManifestPath, "utf8")) as {
          version: string;
        };
        const outdatedVersion = chromeExtensionManifest.version === "2.0.0" ? "1.0.0" : "2.0.0";
        await fs.writeFile(
          installedManifestPath,
          `${JSON.stringify({ ...installedManifest, version: outdatedVersion }, null, 2)}\n`,
        );
        await context.close();
        context = await launchChromium();
        await loadUnpackedExtension(context, installed);
        expect(await waitForExtensionId(context, installed)).toBe(extensionId);
        const outdatedExtensionPage = await context.newPage();
        await outdatedExtensionPage.goto(`chrome-extension://${extensionId}/options.html`);
        await expect.poll(() => relay.bridge.identity?.extensionVersion).toBe(outdatedVersion);
        const outdatedDoctor = await dispatch("/doctor");
        expectDoctorCheck(outdatedDoctor, {
          id: "extension-version",
          status: "warn",
          summary: `running ${outdatedVersion}; bundled ${chromeExtensionManifest.version} (mismatch)`,
          fixHint: expect.stringMatching(/reload/i),
        });
        expect(outdatedDoctor.body).toMatchObject({
          ok: true,
        });

        const extensionContext = routeContext.forProfile("e2e");
        await sendExtensionMessage(outdatedExtensionPage, { type: "unpair" });
        await expect.poll(() => relay.bridge.extensionConnected).toBe(false);
        const pageCountBeforeUnavailableSelection = context.pages().length;
        await expect(extensionContext.ensureTabAvailable()).rejects.toThrow();
        expect(context.pages()).toHaveLength(pageCountBeforeUnavailableSelection);
      },
    );
  }, 120_000);
});
