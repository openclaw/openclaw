import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { normalizeControlUiBuildInfo } from "../../../ui/src/build-info-normalizers.ts";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { takeControlUiScreenshotFrame } from "../../../ui/src/test-helpers/control-ui-e2e-screenshot.ts";
import { startBuiltControlUiE2eServer } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import { installNativePluginMockGateway } from "../../../ui/src/test-helpers/control-ui-plugin-e2e.ts";

const shellRoot = process.env.OPENCLAW_MEMBER_DEVICES_UI_ROOT;
const suite = createControlUiE2eSuite({
  name: "People member devices",
  ...(shellRoot ? { startServer: () => startBuiltControlUiE2eServer(shellRoot) } : {}),
});
const peers = [1, 2, 3, 4].map((index) => `iroh:${String(index).repeat(64)}`);
const fingerprints = [1, 2, 3, 4].map((index) => `fp:${String(index).repeat(64)}`);

suite.define(() => {
  it("shows member devices and confirms an owner-signed transitive removal", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" },
      async ({ page }) => {
        const shell = shellRoot
          ? normalizeControlUiBuildInfo(
              JSON.parse(readFileSync(path.join(shellRoot, "..", "build-info.json"), "utf8")),
            )
          : undefined;
        const gateway = await installNativePluginMockGateway(page, {
          serverBuildId: shell?.buildId,
          serverVersion: shell?.version ?? undefined,
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
              link: { linked: true },
            },
            "openclawId.people": { link: { linked: true } },
          },
        });
        await page.goto(suite.server.baseUrl + "plugin?plugin=openclaw-id-access&id=access");
        await page.locator(".ocid-access").waitFor();
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
        const now = 1_800_000_000;
        await page.clock.setFixedTime(now * 1000);
        const devices = [
          {
            peerKey: peers[0],
            deviceFp: fingerprints[0],
            label: "Chrome on Linux (11111111)",
            approvedBy: { kind: "invite", invite_id: "team-invite" },
          },
          {
            peerKey: peers[1],
            deviceFp: fingerprints[1],
            label: "Chrome on Linux (22222222)",
            approvedBy: { kind: "member_device", device_fp: fingerprints[0] },
          },
          {
            peerKey: peers[2],
            deviceFp: fingerprints[2],
            label: "Chrome on Linux (33333333)",
            approvedBy: { kind: "member_device", device_fp: fingerprints[1] },
          },
          {
            peerKey: peers[3],
            deviceFp: fingerprints[3],
            label: "Device (44444444)",
            approvedBy: { kind: "owner", by: "root" },
          },
        ].map((device) =>
          Object.assign(device, {
            connections: 0,
            lastSeenAt: null,
            lastSeen: now - 300,
            runs: [],
          }),
        );
        const member = {
          accountId: "member-mira",
          displayName: "Mira Example",
          email: "mira@example.test",
          role: "operator",
          peerKeys: peers,
          devices,
        };
        const link = {
          linked: true,
          clawId: "synthetic-claw",
          seq: 4,
          ownerDevices: [{ devicePub, label: "Synthetic owner browser", peerKeys: [], cert: {} }],
          members: [member],
          invites: [],
        };
        await gateway.setMethodResponse("openclawId.people", { link });
        await gateway.emitGatewayEvent("openclawId.people.changed");
        const surface = page.locator(".ocid-access");
        const row = page.locator(".ocid-access__row--member");
        await expect
          .poll(() => row.getByRole("button", { name: "Remove", exact: true }).isEnabled())
          .toBe(true);
        expect(await row.textContent()).toContain("Approved by Chrome on Linux (22222222)");
        expect(await row.textContent()).toContain("Approved via invite team-invite");
        expect(await row.textContent()).toContain("last seen 5 min ago");
        const first = row.locator(".ocid-access__device").first();
        for (const width of [1280, 400, 820]) {
          await page.setViewportSize({ width, height: 1000 });
          const frame = await takeControlUiScreenshotFrame(page, row, [row], {
            animations: "disabled",
            scrollTo: row,
          });
          writeFileSync(path.join(suite.artifactDir, `after-${width}.png`), frame.png);
          await first.getByRole("button", { name: "Remove device", exact: true }).click();
          const confirm = first.getByRole("button", {
            name: "Remove Chrome on Linux (11111111)",
            exact: true,
          });
          await confirm.waitFor();
          expect(await first.getByRole("note").textContent()).toContain(
            "3 devices will be removed: this device and 2 devices it approved, directly or indirectly.",
          );
          expect(await gateway.getRequests("openclawId.authority")).toEqual([]);
          const confirmation = await takeControlUiScreenshotFrame(page, first, [first], {
            animations: "disabled",
            scrollTo: confirm,
          });
          writeFileSync(
            path.join(suite.artifactDir, `confirmation-${width}.png`),
            confirmation.png,
          );
          expect(
            await surface.evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
          await first.getByRole("button", { name: "Cancel", exact: true }).click();
          await confirm.waitFor({ state: "hidden" });
        }
        await gateway.setMethodResponse("openclawId.authority", {
          removal: { devices: 3, connectionsClosed: 2, runsCancelled: 1 },
        });
        await first.getByRole("button", { name: "Remove device", exact: true }).click();
        await first
          .getByRole("button", { name: "Remove Chrome on Linux (11111111)", exact: true })
          .click();
        await expect
          .poll(async () => (await gateway.getRequests("openclawId.authority")).length)
          .toBe(1);
        expect((await gateway.getRequests("openclawId.authority"))[0]?.params).toMatchObject({
          action: "submit",
          statement: { body: { seq: 5, target: { op: "revoke_device", peer_key: peers[0] } } },
        });
        await expect
          .poll(() => surface.textContent())
          .toContain("Chrome on Linux (11111111) removed · 2 connections closed · 1 task stopped");
        await gateway.setMethodResponse("openclawId.people", {
          link: {
            ...link,
            seq: 5,
            members: [{ ...member, peerKeys: peers.slice(3), devices: devices.slice(3) }],
          },
        });
        await gateway.emitGatewayEvent("openclawId.people.changed");
        await expect.poll(() => row.locator(".ocid-access__device").count()).toBe(1);
        expect(await row.locator(".ocid-access__device .ocid-access__title").textContent()).toBe(
          "Device (44444444)",
        );
        await gateway.setMethodResponse("openclawId.people", {
          link: { ...link, ownerDevices: [] },
        });
        await gateway.emitGatewayEvent("openclawId.people.changed");
        await expect
          .poll(() => row.getByRole("button", { name: "Remove device", exact: true }).count())
          .toBe(0);
        expect(await row.textContent()).toContain("Chrome on Linux");
        console.log("Member device screenshots:", suite.artifactDir);
      },
    );
  });
});
