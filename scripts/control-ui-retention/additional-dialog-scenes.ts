import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { expect } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../src/gateway/control-ui-bootstrap-contract.js";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { selectFileAction } from "../../ui/src/e2e/chat-file-actions.test-support.ts";
import { navigateToControlUiSession } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { sessionKey } from "../control-ui-parity/fixtures.ts";
import { baseScenario, type Scene } from "../control-ui-parity/scenarios.ts";

const retainedDraft = "# Workspace notes\n\nSynthetic unsaved file draft.\n";
const draftSeeded = new WeakSet<Page>();
const authFixtures = new WeakMap<Page, { expired: boolean; nextExpiryAt: number }>();
const authImage = createSolidPngBuffer(64, 32, { r: 229, g: 246, b: 238 });

export const additionalDialogScenes: Scene[] = [
  {
    id: "dialog-file-draft-recovery",
    label: "Retained file draft recovery (one blocked update, repeated review)",
    route: "new-session",
    path: "/new",
    ready: "openclaw-new-session-page",
    scenario: {
      featureMethods: [...baseScenario.featureMethods!, "sessions.files.set"],
      historyMessages: [{ role: "assistant", content: "Review `notes.md`.", timestamp: 1 }],
      methodResponses: {
        "sessions.files.get": {
          sessionKey,
          root: "/workspace",
          source: { workspaceId: "workspace-a", root: "/workspace", fileRoot: "/workspace" },
          file: {
            name: "notes.md",
            path: "notes.md",
            workspacePath: "notes.md",
            kind: "read",
            missing: false,
            previewKind: "text",
            contentEncoding: "utf8",
            content: "# Workspace notes\n\nOriginal project notes.\n",
            hash: "unchanged-file-hash",
          },
        },
      },
    },
    prepare: async (page, gateway) => {
      if (!draftSeeded.has(page)) {
        await navigateToControlUiSession(page, sessionKey);
        await page.locator('a.markdown-file-link[data-file-path="notes.md"]').click();
        const file = page.locator(".sidebar-file-view");
        await selectFileAction(file, "Edit file");
        await file.locator(".cm-content").fill(retainedDraft);
        await gateway.setOnline(false);
        await gateway.deferNext("connect");
        const connects = (await gateway.getRequests("connect")).length;
        await gateway.setOnline(true);
        await gateway.waitForRequest("connect", { after: connects });
        await gateway.rejectDeferred("connect", {
          code: "UNAVAILABLE",
          message: "protocol mismatch: Control UI updated; reload this page to continue",
          details: {
            code: "PROTOCOL_MISMATCH",
            gatewayBuildId: "synthetic-retention-replacement",
            reloadRequired: true,
          },
          retryable: false,
        });
        draftSeeded.add(page);
      }
      await page.getByRole("button", { name: /Server updated/u }).click();
      await page.getByRole("button", { name: "Review file drafts", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Review file drafts", exact: true });
      await expect.poll(() => dialog.locator("textarea").inputValue()).toBe(retainedDraft);
      await dialog.getByRole("button", { name: "Download notes.md", exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Keep drafts", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
    },
  },
  {
    id: "dialog-browser-auth-recovery",
    label: "Browser HTTP sign-in recovery (native 30-second expiry cadence)",
    route: "new-session",
    path: "/new",
    ready: "openclaw-new-session-page",
    scenario: {
      historyMessages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              url: "media://inbound/auth-retention.png",
              alt: "Auth retention image",
            },
          ],
          timestamp: 1,
        },
      ],
    },
    prepare: async (page) => {
      let fixture = authFixtures.get(page);
      if (!fixture) {
        fixture = { expired: false, nextExpiryAt: 0 };
        authFixtures.set(page, fixture);
        const state = fixture;
        const rootUrl = new URL("/", page.url()).href;
        // Override the mock Gateway's page route; context routes have lower priority.
        await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, async (route) => {
          if (route.request().method() === "HEAD") {
            await route.fulfill(
              state.expired
                ? { status: 302, headers: { location: rootUrl } }
                : { status: 200, contentType: "application/json", body: "" },
            );
          } else if (route.request().isNavigationRequest()) {
            // The renewal iframe reaches a login page but cannot renew this expiry.
            await route.fulfill({ contentType: "text/html", body: "Synthetic sign-in required." });
          } else {
            await route.fallback();
          }
        });
        await page.context().route("**/__openclaw__/assistant-media?**", async (route) => {
          const params = new URL(route.request().url()).searchParams;
          const metadata = params.get("meta") === "1";
          await route.fulfill(
            state.expired
              ? { status: 401, body: "Synthetic browser session expired." }
              : metadata
                ? {
                    contentType: "application/json",
                    body: JSON.stringify({ available: true, width: 64, height: 32 }),
                  }
                : params.get("variant") === "thumbnail"
                  ? { status: 503, body: "Synthetic thumbnail unavailable." }
                  : { contentType: "image/png", body: authImage },
          );
        });
        await page
          .context()
          .route(rootUrl, (route) =>
            route.fulfill({ contentType: "text/html", body: "Synthetic sign-in page." }),
          );
      }
      await navigateToControlUiSession(page, sessionKey);
      // An unavailable thumbnail exposes the native image-action menu while
      // preserving a fresh HTTP request for every original-download attempt.
      const imageActions = page.getByRole("button", { name: "Image actions", exact: true });
      await imageActions.waitFor();
      // A successful recovery resets dismissal but keeps the document's genuine
      // automatic-probe throttle. Never advance the browser clock around it.
      await delay(Math.max(0, fixture.nextExpiryAt - Date.now()));
      fixture.expired = true;
      await imageActions.click();
      await page.getByRole("menuitem", { name: "Download image", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Sign in to continue loading content",
        exact: true,
      });
      await dialog.waitFor();
      const popupPromise = page.context().waitForEvent("page");
      await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
      const popup = await popupPromise;
      try {
        await popup.getByText("Synthetic sign-in page.", { exact: true }).waitFor();
        fixture.expired = false;
        // Dispatch the real button action without a focus change racing its
        // equivalent on-focus recovery and removing the button before the click.
        await dialog
          .getByRole("button", { name: "Check again", exact: true })
          .dispatchEvent("click");
        await dialog.waitFor({ state: "detached" });
        await expect.poll(() => page.locator("iframe").count()).toBe(0);
        fixture.nextExpiryAt = Date.now() + 30_100;
        console.log("Browser auth recovered through the sign-in popup");
      } finally {
        await popup.close();
      }
    },
  },
];

export const additionalDialogCoverageNotes = [
  "File-draft recovery retains one deliberately dirty draft; after retiring its editor, each cycle reviews it from New Session through the real blocked-update toast. The rejected reconnect intentionally prevents fresh chat-route readiness.",
  "Browser-auth recovery uses one unavailable inbound thumbnail's uncached original-download action, HTTP 401/redirect fixtures, the renewal iframe, and a closed sign-in popup. Its 30-second automatic-probe throttle is preserved; give this scene a 600-second timeout.",
  "Gateway URL confirmation initializes only at document boot; native companion gateway editors belong to a separate renderer. Neither can be represented as repeated same-document Control UI openings.",
];
