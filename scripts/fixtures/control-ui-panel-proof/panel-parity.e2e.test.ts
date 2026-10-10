import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { openChatSidePanelType } from "../../../ui/src/e2e/chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import {
  createRfbRawFrame,
  installScriptedRfbServer,
} from "../../../ui/src/e2e/desktop-rfb-test-support.ts";
import { createControlUiE2eArtifactDir } from "../../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../../../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../../../ui/src/test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  startControlUiE2eServer,
  type ControlUiMockGatewayScenario,
} from "../../../ui/src/test-helpers/control-ui-e2e.ts";

// Temporary migration evidence. The baseline receives this same fixture;
// each revision renders its own source through real routes and Gateway effects.
const suite = createControlUiE2eSuite({
  name: "W-PG-5a visual parity",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});
const variants = [
  { name: "desktop-light", width: 1440, height: 1000, mode: "light" },
  { name: "desktop-dark", width: 1440, height: 1000, mode: "dark" },
  { name: "mobile-light", width: 390, height: 844, mode: "light" },
  { name: "mobile-dark", width: 390, height: 844, mode: "dark" },
] as const;
type Variant = (typeof variants)[number];
const environment = { id: "gateway", type: "local", status: "available", desktop: true };
const historyMessages = [{ role: "assistant", content: "Synthetic panel migration proof." }];

async function withPage(
  variant: Variant,
  scenario: ControlUiMockGatewayScenario,
  run: (
    page: Page,
    gateway: Awaited<ReturnType<typeof installMockGateway>>,
    capture: (state: string, surface: Locator, content: Locator[]) => Promise<void>,
  ) => Promise<void>,
) {
  const artifacts = createControlUiE2eArtifactDir(`wpg5a-${variant.name}`);
  await suite.withPage(
    {
      viewport: { width: variant.width, height: variant.height },
      colorScheme: variant.mode,
      serviceWorkers: "block",
      locale: "en-US",
    },
    async ({ page }) => {
      await page.addInitScript(
        ({ gatewayUrl, mode }) => {
          localStorage.setItem(
            `openclaw.control.settings.v1:${gatewayUrl}`,
            JSON.stringify({ gatewayUrl, theme: "claw", themeMode: mode }),
          );
        },
        { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl), mode: variant.mode },
      );
      const gateway = await installMockGateway(page, {
        historyMessages,
        communityInviteDismissed: true,
        ...scenario,
      });
      const capture = async (state: string, surface: Locator, content: Locator[]) => {
        expect(await page.locator("html").getAttribute("data-theme-mode")).toBe(variant.mode);
        const frame = await takeControlUiScreenshotFrame(page, surface, content, {
          animations: "disabled",
          elements: [surface],
        });
        await writeFile(path.join(artifacts, `${state}.png`), frame.png);
        await writeFile(path.join(artifacts, `${state}-panel.png`), frame.elements[0]!.png);
      };
      await run(page, gateway, capture);
    },
  );
}

suite.define(() => {
  for (const variant of variants) {
    it(`terminal loading, recovery, live canvas, retained island and picker — ${variant.name}`, async () => {
      await withPage(
        variant,
        {
          featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
          terminalEnabled: true,
          deferredMethods: ["terminal.open"],
        },
        async (page, gateway, capture) => {
          await page.goto(`${suite.server.baseUrl}chat`);
          await waitForControlUiGatewayReady(page);
          await openChatSidePanelType(page, "Terminal");
          const panel = page.locator(".sidebar-region__right-runtime openclaw-terminal-panel");
          await gateway.waitForRequest("terminal.open");
          await capture("terminal-loading", panel, [
            panel.locator('[role="status"][aria-busy="true"]'),
          ]);
          await gateway.rejectDeferred("terminal.open", {
            code: "UNAVAILABLE",
            message: "Synthetic terminal unavailable. Retry the connection.",
          });
          await capture("terminal-error", panel, [
            panel.locator('[role="alert"]'),
            panel.getByRole("button", { name: "Retry", exact: true }),
          ]);
          await gateway.deferNext("terminal.open");
          await panel.getByRole("button", { name: "Retry", exact: true }).click();
          await gateway.waitForRequest("terminal.open", { after: 1 });
          await gateway.resolveDeferred("terminal.open");
          const canvas = panel.locator(".tp-host canvas:visible");
          await canvas.waitFor();
          await canvas.click();
          await page.keyboard.type("echo migration-ready");
          await expect
            .poll(async () =>
              (await gateway.getRequests("terminal.input"))
                .map((request) => (request.params as { data?: string }).data ?? "")
                .join(""),
            )
            .toContain("echo migration-ready");
          await capture("terminal-connected", panel, [canvas]);
          const canvasHandle = await canvas.elementHandle();
          await page.locator(".chat-side-panel-toggle").click();
          await expect.poll(() => canvas.isVisible()).toBe(false);
          await page.locator(".chat-side-panel-toggle").click();
          await canvas.waitFor();
          expect(await canvasHandle!.evaluate((element) => element.isConnected)).toBe(true);
          expect(await gateway.getRequests("terminal.open")).toHaveLength(2);
          await capture("terminal-restored", panel, [canvas]);
          await page.getByRole("button", { name: "Terminal sessions", exact: true }).click();
          await capture("terminal-session-picker", panel, [panel.locator('[role="dialog"]')]);
        },
      );
    });

    it(`terminal route unavailable — ${variant.name}`, async () => {
      await withPage(variant, { terminalEnabled: false }, async (page, gateway, capture) => {
        await page.goto(`${suite.server.baseUrl}terminal`);
        await waitForControlUiGatewayReady(page);
        const panel = page.locator("openclaw-terminal-page");
        await capture("terminal-page-unavailable", panel, [
          panel.getByText("The terminal is not available on this gateway."),
          panel.getByRole("button", { name: "New session", exact: true }),
        ]);
        expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
      });
    });

    it(`terminal standalone route — ${variant.name}`, async () => {
      await withPage(
        variant,
        {
          featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
          terminalEnabled: true,
        },
        async (page, gateway, capture) => {
          await page.goto(`${suite.server.baseUrl}terminal`);
          await waitForControlUiGatewayReady(page);
          const panel = page.locator("openclaw-terminal-page");
          await gateway.waitForRequest("terminal.open");
          await capture("terminal-page-connected", panel, [
            panel.locator(".tp-host canvas:visible"),
          ]);
        },
      );
    });

    it(`browser loading, errors and ready screenshot — ${variant.name}`, async () => {
      await withPage(
        variant,
        {
          featureMethods: [...defaultControlUiFeatureMethods, "browser.request"],
          deferredRequests: [{ method: "browser.request", match: { path: "/tabs" } }],
        },
        async (page, gateway, capture) => {
          await page.goto(`${suite.server.baseUrl}chat`);
          await waitForControlUiGatewayReady(page);
          // Use a generated bitmap as the real screenshot transport body. No remote site.
          const png = await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = 800;
            canvas.height = 600;
            const context = canvas.getContext("2d")!;
            context.fillStyle = "#ecf4f8";
            context.fillRect(0, 0, 800, 600);
            context.fillStyle = "#143347";
            context.fillRect(0, 0, 800, 76);
            context.fillStyle = "#ffffff";
            context.font = "bold 24px sans-serif";
            context.fillText("Synthetic browser workspace", 28, 48);
            context.fillStyle = "#25596b";
            context.font = "24px sans-serif";
            context.fillText("Migration proof: no external browser data", 28, 132);
            return canvas.toDataURL("image/png").split(",")[1]!;
          });
          await page.route("**/__openclaw__/assistant-media**", (route) =>
            route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }),
          );
          await openChatSidePanelType(page, "Browser");
          const panel = page.locator(".sidebar-region__right-runtime openclaw-browser-panel");
          await gateway.waitForRequest("browser.request", { match: { path: "/tabs" } });
          await capture("browser-loading", panel, [
            panel.locator('[role="status"][aria-busy="true"]'),
          ]);
          await gateway.rejectDeferred(
            "browser.request",
            { code: "UNAVAILABLE", message: "Synthetic browser source unavailable." },
            { match: { path: "/tabs" } },
          );
          await capture("browser-error", panel, [panel.locator('[role="alert"]')]);
          // A fresh route retries through the public owner without changing internals.
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await gateway.waitForRequest("browser.request", { match: { path: "/tabs" } });
          await gateway.setMethodResponse("browser.request", {
            cases: [
              {
                match: { path: "/tabs" },
                response: {
                  running: true,
                  tabs: [
                    {
                      targetId: "proof-browser",
                      title: "Synthetic workspace",
                      url: "https://workspace.example/",
                    },
                  ],
                },
              },
              {
                match: { path: "/screencast" },
                response: {
                  __mockError: {
                    code: "UNAVAILABLE",
                    message: "Use synthetic screenshot transport",
                  },
                },
              },
              {
                match: { path: "/screenshot" },
                response: {
                  targetId: "proof-browser",
                  path: "/synthetic-proof.png",
                  url: "https://workspace.example/",
                },
              },
              {
                match: { path: "/act" },
                response: {
                  result: {
                    cssWidth: 800,
                    cssHeight: 600,
                    title: "Synthetic workspace",
                    url: "https://workspace.example/",
                  },
                },
              },
            ],
          });
          await gateway.resolveDeferred(
            "browser.request",
            {
              running: true,
              tabs: [
                {
                  targetId: "proof-browser",
                  title: "Synthetic workspace",
                  url: "https://workspace.example/",
                },
              ],
            },
            { match: { path: "/tabs" } },
          );
          const image = panel.locator(".bp-shot");
          await image.waitFor();
          await capture("browser-connected", panel, [image, panel.locator(".bp-url")]);
          await panel.getByRole("button", { name: "Annotate page", exact: true }).click();
          await capture("browser-annotate", panel, [image, panel.locator(".bp-annotatebar")]);
        },
      );
    });

    it.each([
      { running: false, state: "browser-not-running" },
      { running: true, state: "browser-empty" },
    ])("$state — " + variant.name, async ({ running, state }) => {
      await withPage(
        variant,
        {
          featureMethods: [...defaultControlUiFeatureMethods, "browser.request"],
          methodResponses: {
            "browser.request": {
              cases: [{ match: { path: "/tabs" }, response: { running, tabs: [] } }],
            },
          },
        },
        async (page, _gateway, capture) => {
          await page.goto(`${suite.server.baseUrl}chat`);
          await waitForControlUiGatewayReady(page);
          await openChatSidePanelType(page, "Browser");
          const panel = page.locator(".sidebar-region__right-runtime openclaw-browser-panel");
          await capture(state, panel, [panel.locator(".empty-state")]);
        },
      );
    });

    it(`desktop sources and credentials — ${variant.name}`, async () => {
      await withPage(
        variant,
        {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "desktop.observe",
            "environments.list",
          ],
          deferredMethods: ["environments.list"],
          methodResponses: {
            "desktop.observe": {
              transport: "rfb",
              wsPath: "/desktop/observe?token=synthetic",
              expiresAtMs: 60_000,
              control: false,
              auth: "vnc-password",
            },
          },
        },
        async (page, gateway, capture) => {
          await page.goto(`${suite.server.baseUrl}focus/desktop`);
          const panel = page.locator("openclaw-desktop-panel");
          await gateway.waitForRequest("environments.list");
          await capture("desktop-sources-loading", panel, [
            panel.locator('[role="status"][aria-busy="true"]'),
          ]);
          await gateway.resolveDeferred("environments.list", { environments: [] });
          await capture("desktop-sources-empty", panel, [
            panel.getByText("No desktop-capable sources are available.", { exact: true }),
          ]);
          await gateway.deferNext("environments.list");
          await panel.getByRole("button", { name: "Refresh", exact: true }).click();
          await gateway.waitForRequest("environments.list", { after: 1 });
          await gateway.resolveDeferred("environments.list", { environments: [environment] });
          await capture("desktop-sources-ready", panel, [
            panel.getByRole("button", { name: "Connect", exact: true }),
          ]);
          await panel.getByRole("button", { name: "Connect", exact: true }).click();
          await gateway.waitForRequest("desktop.observe");
          await capture("desktop-credentials", panel, [
            panel.getByLabel("VNC password", { exact: true }),
          ]);
        },
      );
    });

    it(`desktop real noVNC island, control and disconnect — ${variant.name}`, async () => {
      await withPage(
        variant,
        {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "desktop.observe",
            "environments.list",
            "environments.status",
          ],
          deferredMethods: ["environments.status"],
          methodResponses: {
            "desktop.observe": {
              cases: [false, true].map((control) => ({
                match: { control },
                response: {
                  transport: "rfb",
                  wsPath: `/desktop/observe?token=synthetic-${control}`,
                  expiresAtMs: 60_000,
                  control,
                },
              })),
            },
          },
        },
        async (page, gateway, capture) => {
          await page.goto(`${suite.server.baseUrl}focus/desktop/source/gateway`);
          const panel = page.locator("openclaw-desktop-panel");
          await gateway.waitForRequest("environments.status");
          await capture("desktop-connecting", panel, [
            panel.locator('[role="status"][aria-busy="true"]'),
          ]);
          const rfb = await installScriptedRfbServer(page);
          await gateway.resolveDeferred("environments.status", environment);
          const canvas = panel.locator(".desktop-surface canvas");
          await canvas.waitFor();
          await expect.poll(rfb.connectionCount).toBe(1);
          await expect.poll(rfb.events).toContain("authenticated:1");
          await rfb.send([createRfbRawFrame()]);
          await capture("desktop-connected", panel, [
            canvas,
            panel.getByRole("button", { name: "Take control", exact: true }),
          ]);
          await panel.getByRole("button", { name: "Take control", exact: true }).click();
          await expect.poll(rfb.events).toContain("authenticated:2");
          await rfb.send([createRfbRawFrame()]);
          await capture("desktop-control", panel, [
            canvas,
            panel.getByRole("button", { name: "Switch to view only", exact: true }),
          ]);
          await rfb.disconnect("Synthetic connection ended");
          await capture("desktop-disconnected", panel, [
            panel.getByRole("button", { name: "Reconnect", exact: true }),
          ]);
        },
      );
    });

    it(`desktop docked view — ${variant.name}`, async () => {
      await withPage(
        variant,
        {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "desktop.observe",
            "environments.list",
            "environments.status",
          ],
          methodResponses: {
            "environments.list": { environments: [environment] },
            "environments.status": environment,
            "desktop.observe": {
              transport: "rfb",
              wsPath: "/desktop/observe?token=synthetic-dock",
              expiresAtMs: 60_000,
              control: false,
            },
          },
        },
        async (page, gateway, capture) => {
          await page.goto(`${suite.server.baseUrl}activity`);
          await waitForControlUiGatewayReady(page);
          const rfb = await installScriptedRfbServer(page);
          await page.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent("openclaw:desktop-toggle", {
                detail: { open: true, environmentId: "gateway" },
              }),
            ),
          );
          const panel = page.locator("openclaw-desktop-panel");
          await gateway.waitForRequest("desktop.observe");
          await expect.poll(rfb.events).toContain("authenticated:1");
          await rfb.send([createRfbRawFrame()]);
          const canvas = panel.locator(".desktop-surface canvas");
          await capture("desktop-dock-connected", panel, [
            canvas,
            panel.getByRole("button", { name: "Dock to bottom", exact: true }),
          ]);
          await panel.getByRole("button", { name: "Dock to bottom", exact: true }).click();
          await capture("desktop-dock-bottom", panel, [canvas]);
        },
      );
    });

    it(`desktop inventory recovery — ${variant.name}`, async () => {
      await withPage(
        variant,
        {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "desktop.observe",
            "environments.list",
            "environments.status",
          ],
          methodResponses: {
            "environments.status": {
              __mockError: { code: "UNAVAILABLE", message: "Synthetic inventory unavailable" },
            },
          },
        },
        async (page, gateway, capture) => {
          await page.goto(`${suite.server.baseUrl}focus/desktop/source/gateway`);
          const panel = page.locator("openclaw-desktop-panel");
          await capture("desktop-inventory-error", panel, [
            panel.getByRole("alert"),
            panel.getByRole("button", { name: "Retry", exact: true }),
          ]);
          expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
        },
      );
    });
  }
});
