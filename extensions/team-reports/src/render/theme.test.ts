import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import { shell } from "./page.js";

const windows: JSDOM["window"][] = [];
afterEach(() => windows.splice(0).forEach((window) => window.close()));

const publicUrl = "https://p.test/team/reports/day/now/?person=a";
const context = {
  basePath: "/team/reports",
  nonce: "fixture",
  absoluteUrl: publicUrl,
  displayTimezone: "UTC",
};
const links = `<a id="history" href="/team/reports/day/prev/?person=a#theme=dark">History</a><a id="absolute" href="https://g.test/team/reports/people/">People</a><a id="external" href="https://e.test/team/reports/">External</a><a id="outside" href="/team/reports-other/">Outside</a>`;
const html = shell(context, "Theme fixture", links, "home");

async function openPage({ url = "", stored = "", blocked = false, light = false } = {}) {
  const { window } = new JSDOM(html, {
    url: new URL(url, "https://g.test/team/reports/").href,
    runScripts: "dangerously",
    beforeParse(frame) {
      Object.defineProperty(frame, "matchMedia", {
        value: () => ({ matches: light, addEventListener() {} }),
      });
      if (blocked) {
        Object.defineProperty(frame, "localStorage", {
          get() {
            throw new frame.DOMException("Storage blocked by sandbox", "SecurityError");
          },
        });
      } else if (stored) {
        frame.localStorage.setItem("theme", stored);
      }
    },
  });
  windows.push(window);
  const headTheme = window.document.documentElement.dataset.theme;
  await new Promise<void>((resolve) => {
    window.addEventListener("load", () => resolve(), { once: true });
  });
  return {
    window,
    headTheme,
    link: (selector: string) => window.document.querySelector(selector)?.getAttribute("href"),
    toggle: () => window.document.querySelector<HTMLButtonElement>("[data-theme-toggle]")?.click(),
  };
}

it.each([
  { url: "#theme=light", stored: "dark", light: false, expected: "light" },
  { url: "#theme=dark", stored: "light", light: true, expected: "dark" },
  { url: "#theme=invalid", stored: "light", light: false, expected: "light" },
  { url: "", stored: "invalid", light: true, expected: "light" },
])("resolves the head theme from fragment, storage, then OS ($url/$stored)", async (options) => {
  expect((await openPage(options)).headTheme).toBe(options.expected);
});

it("carries a sandboxed theme across internal navigation without changing external destinations", async () => {
  const { window, link, toggle } = await openPage({ blocked: true });
  toggle();
  expect(window.document.documentElement.dataset.theme).toBe("light");
  expect(window.location.hash).toBe("#theme=light");
  expect(link("#history")).toBe("/team/reports/day/prev/?person=a#theme=light");
  expect(link("#absolute")).toBe("https://g.test/team/reports/people/#theme=light");
  expect(link('a[aria-current="page"]')).toBe("/team/reports/#theme=light");
  expect(link('a[aria-label="Open in a new window"]')).toBe(`${publicUrl}#theme=light`);
  expect(link("#external")).toBe("https://e.test/team/reports/");
  expect(link("#outside")).toBe("/team/reports-other/");
  const next = await openPage({ url: link("#history") ?? "", blocked: true });
  expect(next.headTheme).toBe("light");
  expect(next.link('a[aria-current="page"]')).toBe("/team/reports/#theme=light");
  next.toggle();
  expect(next.window.location.hash).toBe("#theme=dark");
  expect(next.link("#history")).toBe("/team/reports/day/prev/?person=a#theme=dark");
});

it("persists a separate-window theme when browser storage is available", async () => {
  const { window, toggle } = await openPage({ stored: "dark" });
  toggle();
  expect(window.localStorage.getItem("theme")).toBe("light");
  const next = await openPage({ stored: window.localStorage.getItem("theme") ?? undefined });
  expect(next.headTheme).toBe("light");
});
