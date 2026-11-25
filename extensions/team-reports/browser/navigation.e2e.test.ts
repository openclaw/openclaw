import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import { renderWorkSessionsPage } from "../src/render/work-sessions.js";

const suite = createControlUiE2eSuite({ name: "Team Reports navigation" });

suite.define(() => {
  it("keeps the new-window glyph at its designed size inside the mobile report frame", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const basePath = "/plugins/team-reports";
      const path = `${basePath}/sessions/`;
      await installMockGateway(page, {
        controlUiTabs: [
          { pluginId: "team-reports", id: "team-reports", label: "Reports", slug: "reports", path },
        ],
      });
      await page.route("**" + path, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: renderWorkSessionsPage(
            {
              basePath,
              absoluteUrl: route.request().url(),
              displayTimezone: "UTC",
              nonce: "fixture",
            },
            { available: true, sessions: [{ key: "agent:main:guide", label: "Update the guide" }] },
            0,
          ),
        }),
      );
      await page.goto(suite.server.baseUrl + "reports");
      const link = page
        .frameLocator("openclaw-plugin-page iframe")
        .getByRole("link", { name: "Open in a new window" });
      expect(await link.boundingBox()).toMatchObject({ width: 34, height: 34 });
      expect(await link.locator("svg").boundingBox()).toMatchObject({ width: 16, height: 16 });
    });
  });
});
