import type { Locator, Page } from "playwright";
import { navigationDrawerToggle } from "../../ui/src/test-helpers/control-ui-navigation.ts";

const activePane = ".chat-pane-cache__pane--active";

async function inViewport(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box || (await locator.evaluate((element) => element.closest("[inert]") !== null))) {
    return false;
  }
  const viewport = await locator
    .page()
    .evaluate(() => ({ width: innerWidth, height: innerHeight }));
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y < viewport.height;
}

export async function openNavigationDrawer(page: Page) {
  const chatToggle = page.locator(`${activePane} .mobile-header__navigation`);
  await ((await chatToggle.count()) > 0 ? chatToggle : navigationDrawerToggle(page)).click();
  const drawer = page.locator(".shell--nav-drawer-open > .shell-nav");
  await drawer.waitFor({ state: "visible" });
  await drawer.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
}

export async function navigation(page: Page, view: "pages" | "sessions") {
  const button = page.locator(`[data-navigation-view="${view}"]`).first();
  if (!(await inViewport(button))) {
    await openNavigationDrawer(page);
  }
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
  }
  await page
    .locator(view === "pages" ? ".sidebar-pages" : ".sidebar-recent-session")
    .first()
    .waitFor();
}

export async function prepareInteractionNavigation(page: Page) {
  await navigation(page, "pages");
}

/** Wait two frames; the returned timestamp interval excludes waiting for the first frame. */
export async function frames(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        requestAnimationFrame((start) => requestAnimationFrame((end) => resolve(end - start)));
      }),
  );
}

export async function prepareChat(page: Page) {
  await page.locator(activePane).getByText("Transcript 0 message 399.", { exact: false }).waitFor();
  await frames(page);
}

export async function openInteractionPanel(
  page: Page,
  panel: "Dashboard" | "Browser" = "Dashboard",
  sessionIndex: 0 | 1 = 0,
) {
  if (sessionIndex === 0) {
    await prepareChat(page);
  } else {
    await page
      .locator(activePane)
      .getByText("Transcript 1 message 399.", { exact: false })
      .waitFor();
    await frames(page);
  }
  const pane = page.locator(activePane);
  const mobileHeader = pane.locator(".agent-chat__header--mobile");
  const mobile = await mobileHeader.isVisible();
  const toggle = (mobile ? mobileHeader : pane.locator(".sidebar-region__panels-toggle")).getByRole(
    "button",
    { name: "Panels", exact: true },
  );
  if (mobile) {
    const host = pane.locator(".chat-mobile-host");
    if (!(await host.isVisible())) {
      await toggle.click();
    }
    await host.getByRole("button", { name: "Panels", exact: true }).click();
    await host
      .locator(".chat-panel-launcher-mobile")
      .getByRole("button", { name: panel, exact: true })
      .click();
  } else {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    await pane
      .locator(".side-panel-launcher")
      .getByRole("button")
      .filter({
        has: page
          .getByText(panel, { exact: true })
          .and(page.locator(".side-panel-type-option__label")),
      })
      .click();
  }
}
