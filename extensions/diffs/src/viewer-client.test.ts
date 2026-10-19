/* @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffViewerPayload } from "./types.js";

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

const viewerPayload: DiffViewerPayload = {
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
  oldFile: { name: "a.ts", lang: "text", contents: "old" },
  newFile: { name: "a.ts", lang: "text", contents: "new" },
};

function renderCard(overrides: Partial<DiffViewerPayload> = {}): void {
  const payload = JSON.stringify({ ...viewerPayload, ...overrides });
  document.body.insertAdjacentHTML(
    "beforeend",
    `<section class="oc-diff-card">
      <div data-openclaw-diff-host></div>
      <script type="application/json" data-openclaw-diff-payload>${payload}</script>
    </section>`,
  );
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.openclawDiffsError;
  delete document.documentElement.dataset.openclawDiffsReady;
  delete document.body.dataset.theme;
  vi.clearAllMocks();
});

describe("createToolbarButton icon safety", () => {
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
});

describe("toolbar button toggles", () => {
  it.each([
    ["layout", 0, "diffStyle", "unified", "split"],
    ["theme", 3, "themeType", "dark", "light"],
    ["wrap", 1, "overflow", "wrap", "scroll"],
    ["background", 2, "disableBackground", false, true],
  ] as const)("%s toggle updates viewer options", async (name, index, key, before, after) => {
    renderCard();
    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    const initial = fileDiffSetOptionsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(initial[key]).toBe(before);
    const renderHeaderMetadata = initial.renderHeaderMetadata as () => HTMLElement;
    const buttons = renderHeaderMetadata().querySelectorAll("button");
    expectDefined(buttons[index], `${name} toggle`).click();

    const updated = fileDiffSetOptionsMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(updated[key]).toBe(after);
    if (name === "layout") {
      expect(fileDiffRerenderMock).toHaveBeenCalled();
    }
    if (name === "theme") {
      expect(document.body.dataset.theme).toBe("light");
    }
  });
});

describe("header metadata", () => {
  type HeaderMetadataCallback = () => HTMLElement | null;

  async function hydrateAndGetHeaderCallback(): Promise<HeaderMetadataCallback> {
    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();
    const opts = fileDiffSetOptionsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    return opts.renderHeaderMetadata as HeaderMetadataCallback;
  }

  it("drops the interactive toolbar in image render mode", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<main class="oc-frame" data-render-mode="image"></main>',
    );
    renderCard();
    const renderHeaderMetadata = await hydrateAndGetHeaderCallback();

    expect(renderHeaderMetadata()).toBeNull();
  });

  it("skips summary nav cards during hydration", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<nav class="oc-diff-card oc-diff-nav" aria-label="Changed files"><ol></ol></nav>',
    );
    renderCard();
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    expect(fileDiffHydrateMock).toHaveBeenCalledTimes(1);
  });
});
