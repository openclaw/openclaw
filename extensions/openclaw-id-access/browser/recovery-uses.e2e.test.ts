import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.ts";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { evaluateControlUiContext } from "../../../ui/src/test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../../../ui/src/test-helpers/control-ui-e2e-screenshot.ts";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockSameOriginGatewayScript,
  defaultControlUiFeatureMethods,
  startControlUiE2eServer,
} from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  installNativePluginMockGateway,
  prepareNativePluginMockGatewayScenario,
} from "../../../ui/src/test-helpers/control-ui-plugin-e2e.ts";

// The Inbox is core UI: an older installed shell cannot prove this source change.
const suite = createControlUiE2eSuite({
  name: "Owner recovery-kit notices",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
const use = {
  seq: 9,
  accountId: "member-mira",
  memberName: "Mira Example",
  deviceLabel: "Firefox on Linux",
  peerKey: `iroh:${"1".repeat(64)}`,
  peerFp: `fp:${"1".repeat(64)}`,
  usedAt: 1_800_000_000,
};

suite.define(() => {
  it("notifies the owner, navigates to retained history, and dismisses only the notice", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 1000 },
        reducedMotion: "reduce",
        serviceWorkers: "block",
        locale: "en-US",
        timezoneId: "UTC",
      },
      async ({ page }) => {
        await page.clock.setFixedTime(use.usedAt * 1000 + 60_000);
        await page.addInitScript(createControlUiMockSameOriginGatewayScript());
        const link = {
          linked: true,
          clawId: "synthetic-claw",
          hostname: "synthetic.claw.example",
          seq: 8,
          ownerDevices: [],
          members: [
            {
              accountId: use.accountId,
              displayName: use.memberName,
              role: "operator",
              peerKeys: [],
            },
          ],
          invites: [],
        };
        const scenario = {
          presenceUsers: [{ self: true, id: "owner-synthetic", name: "Synthetic Owner" }],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "openclawId.status",
            "openclawId.people",
          ],
          nativePlugins: [
            {
              pluginId: "openclaw-id-access",
              rootDir: path.resolve("extensions/openclaw-id-access"),
              source: "./browser/index.tsx",
            },
          ],
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          methodResponses: {
            "openclawId.status": {
              status: { state: "on" },
              owner: true,
              channel: "local_operator",
              link: { linked: true, clawId: link.clawId, hostname: link.hostname },
              services: { issuerUrl: null, discoveryUrl: null, loaderDomain: null },
            },
            "openclawId.people": { link },
          },
        };
        const gateway = await installNativePluginMockGateway(page, scenario);
        const prepared = await prepareNativePluginMockGatewayScenario(scenario);
        await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ...createControlUiMockBootstrapConfig(prepared.scenario),
              openclawIdEnabled: true,
            }),
          }),
        );
        await page.goto(`${suite.server.baseUrl}plugin?plugin=openclaw-id-access&id=access`);
        const surface = page.locator(".ocid-access");
        await surface.waitFor();
        await expect.poll(() => surface.locator(".ocid-access__row--member").count()).toBe(1);
        const history = page.getByRole("region", { name: "Recovery kit history" });
        expect(await history.count()).toBe(0);
        const capture = async (stage: string, target = surface) => {
          for (const mode of ["light", "dark"] as const) {
            await evaluateControlUiContext(
              page,
              (context, next) => context.theme.setMode(next),
              mode,
            );
            await expect
              .poll(() => page.locator("html").getAttribute("data-theme-mode"))
              .toBe(mode);
            const frame = await takeControlUiScreenshotFrame(page, target, [target], {
              animations: "disabled",
              scrollTo: target,
            });
            writeFileSync(path.join(suite.artifactDir, `${stage}-${mode}.png`), frame.png);
          }
        };
        await capture("before-recovery-use");
        await gateway.setMethodResponse("openclawId.people", {
          link: { ...link, seq: 9, recoveryUses: [use] },
        });
        await gateway.emitGatewayEvent("openclawId.people.changed", {});
        await expect.poll(() => history.textContent()).toContain("Browser added: Firefox on Linux");
        expect(await history.locator("time").textContent()).toBe("Jan 15, 2027, 8:00:00 AM UTC");
        await page.locator("openclaw-sidebar-attention:visible .sidebar-issues-button").click();
        const notice = page.locator('[data-attention-kind="openClawIdRecoveryUse"]');
        await expect.poll(() => notice.textContent()).toContain("Mira Example used a recovery kit");
        expect(await notice.textContent()).toContain("Firefox on Linux");
        expect(await notice.textContent()).toContain("Jan 15, 2027, 8:00:00 AM UTC");
        await capture("recovery-inbox", notice);
        await notice.locator("a").click();
        await expect
          .poll(() => new URL(page.url()).search)
          .toBe("?plugin=openclaw-id-access&id=access");
        await expect.poll(() => notice.count()).toBe(0);
        await capture("recovery-history", history);

        // The durable projection is independent of the current member/device roster.
        await gateway.setMethodResponse("openclawId.people", {
          link: { ...link, seq: 10, members: [], recoveryUses: [use] },
        });
        await gateway.emitGatewayEvent("openclawId.people.changed", {});
        await expect.poll(() => surface.locator(".ocid-access__row--member").count()).toBe(0);
        expect(await history.textContent()).toContain("Mira Example used a recovery kit");
        await page.locator("openclaw-sidebar-attention:visible .sidebar-issues-button").click();
        await notice.hover();
        await notice
          .getByRole("button", { name: "Dismiss Mira Example used a recovery kit" })
          .click();
        await expect.poll(() => notice.count()).toBe(0);
        expect(await history.textContent()).toContain("Browser added: Firefox on Linux");
        await page.locator("openclaw-sidebar-attention:visible .sidebar-issues-button").click();
        await capture("history-after-member-removal", history);
        expect(await gateway.getRequests("openclawId.authority")).toEqual([]);
        console.log("Owner recovery screenshots (source core + source plugin):", suite.artifactDir);
      },
    );
  });
});
