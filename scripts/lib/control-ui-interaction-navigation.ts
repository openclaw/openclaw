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

/** Traverse with native desktop input; Firefox caps each wheel event to one page. */
export async function scrollTranscriptToTop(page: Page) {
  const selector = `${activePane} .chat-thread`;
  const thread = page.locator(selector);
  let wheelEvents = 0;
  if (page.viewportSize()!.width < 768) {
    // Playwright's mobile WebKit driver has no wheel input. Keep the same
    // scrollport jump for every mobile engine; this is not wheel latency.
    await thread.evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
  } else {
    await thread.hover();
    const { top, height } = await thread.evaluate((element) => ({
      top: element.scrollTop,
      height: element.clientHeight,
    }));
    const distance = Math.floor(height * 0.75);
    // Allow partial native progress without an unbounded gesture loop.
    const limit = Math.ceil(top / distance) * 2 + 2;
    for (; wheelEvents < limit; wheelEvents++) {
      const previous = await thread.evaluate((element) => element.scrollTop);
      if (previous <= 0) {
        break;
      }
      await page.mouse.wheel(0, -distance);
      await page.waitForFunction(
        ({ selector, previous }) => document.querySelector(selector)!.scrollTop < previous,
        { selector, previous },
      );
    }
    if ((await thread.evaluate((element) => element.scrollTop)) > 0) {
      throw new Error(`Transcript did not reach the top after ${wheelEvents} wheel events`);
    }
  }
  await thread.getByText("Transcript 0 message 0.", { exact: false }).waitFor();
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.scrollTop === 0,
    selector,
  );
  await frames(page);
  return { wheelEvents };
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
