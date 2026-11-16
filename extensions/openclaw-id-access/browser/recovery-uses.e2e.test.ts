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
  it("opens the kit-added browser from the Inbox, confirms removal, and retains honest history", async () => {
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
              peerKeys: [use.peerKey],
              recoveryKit: true,
              devices: [
                {
                  peerKey: use.peerKey,
                  deviceFp: use.peerFp,
                  label: use.deviceLabel,
                  approvedBy: { kind: "member_recovery_kit", device_fp: `fp:${"5".repeat(64)}` },
                  connections: 0,
                  lastSeenAt: null,
                  lastSeen: use.usedAt,
                  runs: [],
                },
              ],
            },
          ],
          invites: [],
        };
        const otherMember = {
          accountId: "other-member",
          displayName: "Other Member",
          role: "viewer",
          peerKeys: [],
          devices: [],
          recoveryKit: false,
        };
        link.members.unshift({ ...link.members[0]!, ...otherMember });
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
        const devicePub = await page.evaluate(async () => {
          const pair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
          const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
          await new Promise<void>((resolve, reject) => {
            const open = indexedDB.open("openclaw-id", 1);
            open.addEventListener("upgradeneeded", () =>
              open.result.createObjectStore("owner-devices"),
            );
            open.addEventListener("error", () =>
              reject(new Error("Could not open device test store", { cause: open.error })),
            );
            open.addEventListener("success", () => {
              const db = open.result;
              const tx = db.transaction("owner-devices", "readwrite");
              tx.objectStore("owner-devices").put(pair, "synthetic-claw");
              tx.addEventListener("complete", () => {
                db.close();
                resolve();
              });
              tx.addEventListener("error", () => {
                db.close();
                reject(new Error("Could not save test owner device", { cause: tx.error }));
              });
            });
          });
          return (
            "ed25519:" + Array.from(raw, (value) => value.toString(16).padStart(2, "0")).join("")
          );
        });
        const ownerLink = {
          ...link,
          ownerDevices: [{ devicePub, label: "Synthetic owner browser", peerKeys: [], cert: {} }],
        };
        await gateway.setMethodResponse("openclawId.people", { link: ownerLink });
        await gateway.emitGatewayEvent("openclawId.people.changed", {});
        await expect.poll(() => surface.locator(".ocid-access__kit-badge").count()).toBe(1);
        await expect
          .poll(() =>
            surface.getByRole("button", { name: "Remove device", exact: true }).isVisible(),
          )
          .toBe(true);
        const history = page.getByRole("region", { name: "Recovery kit history" });
        expect(await history.count()).toBe(0);
        const capture = async (stage: string, target = surface) => {
          for (const width of target === surface || target === history ? [390, 1440] : [1440]) {
            await page.setViewportSize({ width, height: 1000 });
            expect(
              await surface.evaluate((element) => element.scrollWidth <= element.clientWidth),
            ).toBe(true);
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
              writeFileSync(
                path.join(suite.artifactDir, `${stage}-${width}-${mode}.png`),
                frame.png,
              );
            }
          }
        };
        await capture("before-recovery-use");
        await gateway.setMethodResponse("openclawId.people", {
          link: { ...ownerLink, seq: 9, recoveryUses: [use] },
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
          .toBe(
            `?plugin=openclaw-id-access&id=access&${new URLSearchParams({ "p.member": use.accountId, "p.device": use.peerKey })}`,
          );
        await expect.poll(() => notice.count()).toBe(0);
        const row = surface.locator(".ocid-access__row--member");
        await expect.poll(() => row.count()).toBe(1);
        expect(await row.textContent()).toContain(use.memberName);
        expect(await row.textContent()).not.toContain("Other Member");
        const highlighted = row.locator(".ocid-access__device--highlighted");
        await expect.poll(() => highlighted.textContent()).toContain(use.deviceLabel);
        expect(
          await row
            .locator(".ocid-access__kit-badge")
            .evaluate((element) => getComputedStyle(element).textTransform),
        ).toBe("none");
        await capture("recovery-member");
        await surface.getByRole("link", { name: "All members", exact: true }).click();
        await expect.poll(() => surface.locator(".ocid-access__row--member").count()).toBe(2);
        const review = history.getByRole("link", { name: "Review browser", exact: true });
        expect(
          new URL((await review.getAttribute("href")) ?? "", page.url()).searchParams.get(
            "p.device",
          ),
        ).toBe(use.peerKey);
        await review.click();
        await expect.poll(() => row.count()).toBe(1);
        await expect.poll(() => highlighted.isVisible()).toBe(true);
        await highlighted.getByRole("button", { name: "Remove device", exact: true }).click();
        const confirm = highlighted.getByRole("button", {
          name: `Remove ${use.deviceLabel}`,
          exact: true,
        });
        await confirm.waitFor();
        expect(await gateway.getRequests("openclawId.authority")).toEqual([]);
        await capture("recovery-removal-confirmation");
        await gateway.setMethodResponse("openclawId.authority", {
          removal: { devices: 1, connectionsClosed: 0, runsCancelled: 0 },
        });
        await confirm.click();
        await expect
          .poll(async () => (await gateway.getRequests("openclawId.authority")).length)
          .toBe(1);
        expect((await gateway.getRequests("openclawId.authority"))[0]?.params).toMatchObject({
          action: "submit",
          statement: { body: { seq: 10, target: { op: "revoke_device", peer_key: use.peerKey } } },
        });
        await expect.poll(() => surface.textContent()).toContain("Firefox on Linux removed");
        await gateway.setMethodResponse("openclawId.people", {
          link: {
            ...ownerLink,
            seq: 10,
            members: ownerLink.members.map((member) => ({ ...member, peerKeys: [], devices: [] })),
            recoveryUses: [use],
          },
        });
        await gateway.emitGatewayEvent("openclawId.people.changed", {});
        await expect
          .poll(() => row.textContent())
          .toContain("This browser has been removed. It no longer has access.");
        expect(await highlighted.count()).toBe(0);
        await capture("recovery-browser-removed");

        // The durable projection is independent of the current member/device roster.
        await gateway.setMethodResponse("openclawId.people", {
          link: { ...ownerLink, seq: 11, members: [], recoveryUses: [use] },
        });
        await gateway.emitGatewayEvent("openclawId.people.changed", {});
        await expect.poll(() => surface.locator(".ocid-access__row--member").count()).toBe(0);
        expect(await history.textContent()).toContain("Mira Example (removed) used a recovery kit");
        await page.locator("openclaw-sidebar-attention:visible .sidebar-issues-button").click();
        await notice.hover();
        await notice
          .getByRole("button", { name: "Dismiss Mira Example used a recovery kit" })
          .click();
        await expect.poll(() => notice.count()).toBe(0);
        expect(await history.textContent()).toContain("Browser added: Firefox on Linux");
        await page.locator("openclaw-sidebar-attention:visible .sidebar-issues-button").click();
        await capture("history-after-member-removal");
        expect(await surface.textContent()).toContain(
          "This member has been removed. Their devices no longer have access.",
        );
        expect(
          await surface.getByRole("button", { name: "Remove device", exact: true }).count(),
        ).toBe(0);
        expect((await gateway.getRequests("openclawId.authority")).length).toBe(1);
        console.log("Owner recovery screenshots (source core + source plugin):", suite.artifactDir);
      },
    );
  });
});
