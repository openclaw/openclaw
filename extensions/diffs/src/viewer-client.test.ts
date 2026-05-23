/* @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const disableAutoStartKey = Symbol.for("openclaw.diffs.disableAutoStart");
(globalThis as typeof globalThis & Record<symbol, unknown>)[disableAutoStartKey] = true;

const VIEWER_CLIENT_SRC = readFileSync(
  path.join(process.cwd(), "extensions/diffs/src/viewer-client.ts"),
  "utf8",
);

const XSS_PATTERNS = ["onerror", "<script", "onclick", "javascript:", "onload"];

const {
  fileDiffHydrateMock,
  fileDiffRerenderMock,
  fileDiffSetOptionsMock,
  preloadHighlighterMock,
} = vi.hoisted(() => ({
  fileDiffHydrateMock: vi.fn(),
  fileDiffRerenderMock: vi.fn(),
  fileDiffSetOptionsMock: vi.fn(),
  preloadHighlighterMock: vi.fn(async () => undefined),
}));

vi.mock("@pierre/diffs", () => ({
  FileDiff: class {
    hydrate(params: unknown) {
      return fileDiffHydrateMock(params);
    }
    rerender() {
      return fileDiffRerenderMock();
    }
    setOptions(params: unknown) {
      return fileDiffSetOptionsMock(params);
    }
  },
  preloadHighlighter: preloadHighlighterMock,
}));

const viewerPayload = JSON.stringify({
  prerenderedHTML: "<div>diff</div>",
  options: {
    theme: { light: "pierre-light", dark: "pierre-dark" },
    diffStyle: "unified",
    diffIndicators: "bars",
    disableLineNumbers: false,
    expandUnchanged: false,
    themeType: "dark",
    backgroundEnabled: true,
    overflow: "wrap",
    unsafeCSS: "",
  },
  langs: ["text"],
  oldFile: { fileName: "a.ts", lang: "text", content: "old" },
  newFile: { fileName: "a.ts", lang: "text", content: "new" },
});

const splitViewerPayload = JSON.stringify({
  prerenderedHTML: "<div>split diff</div>",
  options: {
    theme: { light: "pierre-light", dark: "pierre-dark" },
    diffStyle: "split",
    diffIndicators: "bars",
    disableLineNumbers: false,
    expandUnchanged: false,
    themeType: "light",
    backgroundEnabled: false,
    overflow: "scroll",
    unsafeCSS: "",
  },
  langs: ["typescript"],
  fileDiff: {
    hunks: [],
    oldFile: { fileName: "a.ts", lang: "typescript" },
    newFile: { fileName: "a.ts", lang: "typescript" },
  },
});

function renderCard(): void {
  renderCardWithPayload(viewerPayload, false);
}

function renderCardWithPayload(payload: string, includeShadowTemplate = true): void {
  const shadowTemplate = includeShadowTemplate
    ? `<template shadowrootmode="open"><div data-shadow-seed>seed</div></template>`
    : "";
  document.body.insertAdjacentHTML(
    "beforeend",
    `<section class="oc-diff-card">
      <div data-openclaw-diff-host>${shadowTemplate}</div>
      <script type="application/json" data-openclaw-diff-payload>${payload}</script>
    </section>`,
  );
}

function getLastSetOptions(): Record<string, unknown> {
  const calls = fileDiffSetOptionsMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
}

function getToolbarButton(options: Record<string, unknown>, label: string): HTMLButtonElement {
  const renderHeaderMetadata = options.renderHeaderMetadata as () => HTMLElement;
  const toolbar = renderHeaderMetadata();
  const button = toolbar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  return button;
}

describe("createToolbarButton icon safety", () => {
  it("toolbarIconSvg map exists and has exactly 8 icon names", () => {
    const requiredNames = [
      "split",
      "unified",
      "wrap-on",
      "wrap-off",
      "background-on",
      "background-off",
      "theme-dark",
      "theme-light",
    ] as const;
    for (const name of requiredNames) {
      expect(
        VIEWER_CLIENT_SRC.includes(name + ":") || VIEWER_CLIENT_SRC.includes(`"${name}"`),
        `icon "${name}" should exist in toolbarIconSvg`,
      ).toBe(true);
    }
  });

  it("no iconMarkup: string parameter exists", () => {
    expect(VIEWER_CLIENT_SRC.includes("iconMarkup: string")).toBe(false);
  });

  it("innerHTML reads only from toolbarIconSvg lookup", () => {
    expect(VIEWER_CLIENT_SRC.includes("button.innerHTML = toolbarIconSvg[params.icon]")).toBe(true);
  });

  it("SVG strings in toolbarIconSvg contain no XSS patterns", () => {
    for (const pattern of XSS_PATTERNS) {
      expect(VIEWER_CLIENT_SRC.includes(pattern), `source must not contain "${pattern}"`).toBe(
        false,
      );
    }
  });

  it("old icon functions are removed", () => {
    const removedFunctions = [
      "function splitIcon(",
      "function unifiedIcon(",
      "function wrapIcon(",
      "function backgroundIcon(",
      "function themeIcon(",
    ];
    for (const fn of removedFunctions) {
      expect(VIEWER_CLIENT_SRC.includes(fn), `"${fn}" should be removed`).toBe(false);
    }
  });
});

describe("hydrateViewer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete document.documentElement.dataset.openclawDiffsError;
    delete document.documentElement.dataset.openclawDiffsReady;
    vi.clearAllMocks();
  });

  it("continues hydrating later cards when one card throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderCard();
    renderCard();
    fileDiffHydrateMock.mockImplementationOnce(() => {
      throw new Error("broken card");
    });
    const { controllers, hydrateViewer } = await import("./viewer-client.js");
    controllers.splice(0);

    await hydrateViewer();

    expect(fileDiffHydrateMock).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "Skipping diff card that failed to hydrate",
      expect.any(Error),
    );
    expect(document.documentElement.dataset.openclawDiffsError).toBeUndefined();
    warn.mockRestore();
  });

  it("does not retain controllers when initial state application throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderCard();
    renderCard();
    fileDiffSetOptionsMock.mockImplementationOnce(() => {
      throw new Error("broken options");
    });
    const { controllers, hydrateViewer } = await import("./viewer-client.js");
    controllers.splice(0);

    await hydrateViewer();

    expect(fileDiffHydrateMock).toHaveBeenCalledTimes(2);
    expect(fileDiffSetOptionsMock).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "Skipping diff card that failed to hydrate",
      expect.any(Error),
    );
    expect(document.documentElement.dataset.openclawDiffsError).toBeUndefined();
    warn.mockRestore();
  });

  it("seeds viewer state from the first payload and syncs toolbar toggles across controllers", async () => {
    renderCardWithPayload(splitViewerPayload);
    renderCardWithPayload(viewerPayload);
    const { controllers, hydrateViewer } = await import("./viewer-client.js");
    controllers.splice(0);

    await hydrateViewer();

    expect(controllers).toHaveLength(2);
    expect(preloadHighlighterMock).toHaveBeenCalledWith({
      themes: ["pierre-light", "pierre-dark"],
      langs: ["typescript", "text"],
    });
    expect(document.body.dataset.theme).toBe("light");
    expect(document.querySelector("[data-openclaw-diff-host]")?.shadowRoot?.textContent).toContain(
      "seed",
    );

    const initialOptions = getLastSetOptions();
    expect(initialOptions).toMatchObject({
      themeType: "light",
      diffStyle: "split",
      overflow: "scroll",
      disableBackground: true,
    });

    const callsBeforeClick = fileDiffSetOptionsMock.mock.calls.length;
    getToolbarButton(initialOptions, "Switch to unified diff").click();

    expect(fileDiffSetOptionsMock.mock.calls.length).toBe(callsBeforeClick + 2);
    expect(document.body.dataset.theme).toBe("light");
    expect(getLastSetOptions()).toMatchObject({
      themeType: "light",
      diffStyle: "unified",
      overflow: "scroll",
      disableBackground: true,
    });
  });
});
