import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { renderPersonPage } from "../src/render/html.js";

const suite = createControlUiE2eSuite({ name: "Team Reports avatars" });

suite.define(() => {
  it("paints the same initials for a missing photo as for a person without a photo", async () => {
    await suite.withPage({}, async ({ page }) => {
      const basePath = "/fixture/reports";
      await page.route("**/fixture/reports/people/*/", (route) => {
        const absoluteUrl = route.request().url();
        const login = new URL(absoluteUrl).pathname.split("/").at(-2) ?? "";
        return route.fulfill({
          contentType: "text/html",
          body: renderPersonPage(
            { basePath, absoluteUrl, nonce: "fixture", displayTimezone: "UTC" },
            { display: "Robin Lane", github: [login] },
            [],
          ),
        });
      });
      await page.route("https://avatars.githubusercontent.com/**", (route) =>
        route.request().url().includes("/fixture-missing?")
          ? route.fulfill({ status: 404, body: "" })
          : route.fulfill({
              contentType: "image/svg+xml",
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="teal"/></svg>',
            }),
      );
      const person = (login: string) =>
        page.goto(new URL(`${basePath}/people/${login}/`, suite.server.baseUrl).href);
      const badge = page.locator(".person-hero .oc-avatar");
      const decodePhoto = () => badge.evaluate((el) => el.querySelector("img")?.decode());
      await person("no.photo");
      const initials = await badge.screenshot();
      await person("fixture-missing");
      await expect(decodePhoto()).rejects.toThrow();
      expect((await badge.screenshot()).equals(initials)).toBe(true);
      await person("fixture-loaded");
      await decodePhoto();
      expect((await badge.screenshot()).equals(initials)).toBe(false);
    });
  });
});
