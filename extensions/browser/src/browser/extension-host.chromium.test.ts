import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { BrowserServerState } from "./server-context.js";

const fixture = vi.hoisted(() => ({
  root: "",
  state: undefined as BrowserServerState | undefined,
}));
// mock-isolation: Exercise the production launcher, never the operator's state or service.
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>()),
  get CONFIG_DIR() {
    return fixture.root;
  },
}));
vi.mock("./paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./paths.js")>()),
  get DEFAULT_DOWNLOAD_DIR() {
    return path.join(fixture.root, "downloads");
  },
}));
vi.mock("../browser-control-state.js", () => ({
  getBrowserControlState: () => fixture.state,
  createBrowserControlContext: () =>
    createBrowserRouteContext({ getState: () => fixture.state ?? null }),
}));
vi.mock("../control-service.js", () => ({
  startBrowserControlServiceFromConfig: async () => fixture.state,
}));

import { withCdpSocket } from "./cdp.helpers.js";
import { getChromeWebSocketEndpoint } from "./chrome.js";
import { registerBrowserExtension } from "./extension-host.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";
import { getFreePort } from "./test-port.js";

it.runIf(process.env.OPENCLAW_BROWSER_EXTENSION_E2E === "1")(
  "launches a fixture extension and calls its worker with a real Chrome tab id",
  async () => {
    fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-extension-chromium-"));
    const port = await getFreePort();
    const profile = makeBrowserProfile({
      cdpPort: port,
      cdpUrl: `http://127.0.0.1:${port}`,
      headless: true,
    });
    fixture.state = makeBrowserServerState({
      profile,
      resolvedOverrides: { noSandbox: true, headless: true },
    });
    const extensionDir = path.join(fixture.root, "extension");
    await fs.mkdir(extensionDir);
    const publicKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({
      type: "spki",
      format: "der",
    });
    const id = createHash("sha256")
      .update(publicKey)
      .digest("hex")
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
    await fs.writeFile(
      path.join(extensionDir, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Synthetic extension host proof",
        version: "1.0",
        key: publicKey.toString("base64"),
        permissions: ["tabs"],
        background: { service_worker: "background.js" },
      }),
    );
    await fs.writeFile(
      path.join(extensionDir, "background.js"),
      "globalThis.api = { ready: true }; chrome.runtime.onInstalled.addListener(() => {});\n",
    );
    const registration = await registerBrowserExtension({
      profile: profile.name,
      principal: "synthetic-person",
      extension: { id, unpackedPath: extensionDir, minimumVersion: "1.0" },
    });
    try {
      const session = await registration.openSession({ timeoutMs: 15_000 });
      try {
        expect(
          await session.callInServiceWorker(
            (args: { token: string }) => ({
              length: args.token.length,
              ready: Reflect.get(globalThis, "api").ready,
            }),
            { token: "synthetic-token" },
          ),
        ).toEqual({ length: 15, ready: true });
        const ctx = createBrowserRouteContext({
          getState: () => fixture.state ?? null,
        }).forProfile();
        await ctx.openTab("about:blank");
        const tabs = await ctx.listTabs();
        const tab = tabs.find((candidate) => candidate.type === "page")!;
        expect(tab).toBeDefined();
        const chromeTabId = await session.withExclusiveTab(
          tab,
          async () => await session.resolveChromeTabId(tab),
        );
        expect(chromeTabId).toBeGreaterThanOrEqual(0);
        const endpoint = await getChromeWebSocketEndpoint(profile.cdpUrl);
        expect(endpoint).toBeTruthy();
        await withCdpSocket(endpoint!.url, async (send) => {
          const duplicate = (await send("Target.createTarget", { url: tab.url })) as {
            targetId: string;
          };
          try {
            await expect(session.resolveChromeTabId(tab)).rejects.toThrow("uniquely");
          } finally {
            await send("Target.closeTarget", { targetId: duplicate.targetId });
          }
        });
      } finally {
        await session.close();
      }
    } finally {
      await registration.close();
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  },
  30_000,
);
