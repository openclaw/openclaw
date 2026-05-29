/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffViewerPayload } from "./types.js";

const disableAutoStartKey = Symbol.for("openclaw.diffs.disableAutoStart");
(globalThis as typeof globalThis & Record<symbol, unknown>)[disableAutoStartKey] = true;

const VIEWER_CLIENT_SRC = readFileSync(
  path.join(process.cwd(), "extensions/diffs/src/viewer-client.ts"),
  "utf8",
);

const XSS_PATTERNS = ["onerror", "<script", "onclick", "javascript:", "onload"];

const diffMocks = vi.hoisted(() => {
  type MockFileDiffOptions = Record<string, unknown> & {
    renderHeaderMetadata?: () => HTMLElement;
  };

  class MockFileDiff {
    static instances: MockFileDiff[] = [];
    static throwNextHydrate = 0;
    static throwNextSetOptions = 0;

    hydrate = vi.fn((params: Record<string, unknown>) => {
      hydrateSpy(params);
      this.hydrateParams = params;
      if (MockFileDiff.throwNextHydrate > 0) {
        MockFileDiff.throwNextHydrate -= 1;
        throw new Error("broken card");
      }
      const fileContainer = params.fileContainer as HTMLElement;
      const toolbar = this.options.renderHeaderMetadata?.();
      if (toolbar instanceof HTMLElement) {
        (fileContainer.shadowRoot ?? fileContainer).append(toolbar);
      }
    });
    hydrateParams: Record<string, unknown> | undefined;
    options: MockFileDiffOptions;
    rerender = vi.fn(() => {
      rerenderSpy();
    });
    setOptions = vi.fn((options: MockFileDiffOptions) => {
      setOptionsSpy(options);
      if (MockFileDiff.throwNextSetOptions > 0) {
        MockFileDiff.throwNextSetOptions -= 1;
        throw new Error("broken options");
      }
      this.options = options;
    });

    constructor(options: MockFileDiffOptions) {
      this.options = options;
      MockFileDiff.instances.push(this);
    }
  }

  const hydrateSpy = vi.fn();
  const rerenderSpy = vi.fn();
  const setOptionsSpy = vi.fn();

  return {
    MockFileDiff,
    hydrateSpy,
    preloadHighlighter: vi.fn(async () => {}),
    rerenderSpy,
    resolveLanguage: vi.fn(async (lang: string) => lang),
    setOptionsSpy,
  };
});

vi.mock("@pierre/diffs", () => ({
  FileDiff: diffMocks.MockFileDiff,
  preloadHighlighter: diffMocks.preloadHighlighter,
  resolveLanguage: diffMocks.resolveLanguage,
}));

function payload(overrides: Partial<DiffViewerPayload> = {}): DiffViewerPayload {
  return {
    prerenderedHTML: "<div data-prerendered>diff</div>",
    options: {
      theme: {
        light: "pierre-light",
        dark: "pierre-dark",
      },
      diffStyle: "split",
      diffIndicators: "bars",
      disableLineNumbers: false,
      expandUnchanged: false,
      themeType: "light",
      backgroundEnabled: false,
      overflow: "scroll",
      unsafeCSS: ".diff{}",
    },
    langs: ["text"],
    oldFile: { name: "before.ts", contents: "const value = 1;\n", lang: "text" },
    newFile: { name: "after.ts", contents: "const value = 2;\n", lang: "text" },
    ...overrides,
  };
}

function addCard(diffPayload: DiffViewerPayload, options: { withTemplate?: boolean } = {}) {
  const card = document.createElement("section");
  card.className = "oc-diff-card";
  card.innerHTML = `
    <div data-openclaw-diff-host>
      ${
        options.withTemplate
          ? '<template shadowrootmode="open"><span data-shadow-template>shell</span></template>'
          : ""
      }
    </div>
    <script type="application/json" data-openclaw-diff-payload></script>
  `;
  const script = card.querySelector<HTMLScriptElement>("[data-openclaw-diff-payload]");
  if (!script) {
    throw new Error("missing payload script");
  }
  script.textContent = JSON.stringify(diffPayload);
  document.body.append(card);
  return {
    card,
    host: card.querySelector<HTMLElement>("[data-openclaw-diff-host]"),
  };
}

function renderCard(): void {
  addCard(payload());
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
    (globalThis as typeof globalThis & Record<symbol, unknown>)[disableAutoStartKey] = true;
    vi.resetModules();
    diffMocks.MockFileDiff.instances.length = 0;
    diffMocks.MockFileDiff.throwNextHydrate = 0;
    diffMocks.MockFileDiff.throwNextSetOptions = 0;
    diffMocks.hydrateSpy.mockClear();
    diffMocks.preloadHighlighter.mockClear();
    diffMocks.rerenderSpy.mockClear();
    diffMocks.resolveLanguage.mockClear();
    diffMocks.setOptionsSpy.mockClear();
    document.body.innerHTML = "";
    delete document.body.dataset.theme;
    delete document.documentElement.dataset.openclawDiffsReady;
    delete document.documentElement.dataset.openclawDiffsError;
  });

  it("continues hydrating later cards when one card throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderCard();
    renderCard();
    diffMocks.MockFileDiff.throwNextHydrate = 1;
    const { controllers, hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    expect(diffMocks.hydrateSpy).toHaveBeenCalledTimes(2);
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
    diffMocks.MockFileDiff.throwNextSetOptions = 1;
    const { controllers, hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    expect(diffMocks.hydrateSpy).toHaveBeenCalledTimes(2);
    expect(diffMocks.setOptionsSpy).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "Skipping diff card that failed to hydrate",
      expect.any(Error),
    );
    expect(document.documentElement.dataset.openclawDiffsError).toBeUndefined();
    warn.mockRestore();
  });

  it("hydrates cards from payload scripts and seeds viewer state from the first card", async () => {
    const first = addCard(payload(), { withTemplate: true });
    const secondPayload = payload({
      fileDiff: {
        name: "new.txt",
        prevName: "old.txt",
        type: "change",
        hunks: [],
        splitLineCount: 0,
        unifiedLineCount: 0,
        isPartial: true,
        deletionLines: ["old"],
        additionLines: ["new"],
      },
      langs: ["text", "javascript"],
      oldFile: undefined,
      newFile: undefined,
    });
    const second = addCard(secondPayload);
    const { controllers, hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    expect(document.body.dataset.theme).toBe("light");
    expect(diffMocks.preloadHighlighter).toHaveBeenCalledWith({
      themes: ["pierre-light", "pierre-dark"],
      langs: ["text", "javascript"],
    });
    expect(controllers).toHaveLength(2);
    expect(diffMocks.MockFileDiff.instances).toHaveLength(2);

    const [firstDiff, secondDiff] = diffMocks.MockFileDiff.instances;
    expect(first.host?.shadowRoot?.querySelector("[data-shadow-template]")).not.toBeNull();
    expect(first.host?.querySelector("template[shadowrootmode='open']")).toBeNull();
    expect(firstDiff?.hydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        fileContainer: first.host,
        oldFile: expect.objectContaining({ name: "before.ts" }),
        newFile: expect.objectContaining({ name: "after.ts" }),
        prerenderedHTML: "<div data-prerendered>diff</div>",
      }),
    );
    expect(secondDiff?.hydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        fileContainer: second.host,
        fileDiff: secondPayload.fileDiff,
      }),
    );
    expect(firstDiff?.options).toEqual(
      expect.objectContaining({
        themeType: "light",
        diffStyle: "split",
        overflow: "scroll",
        disableBackground: true,
      }),
    );
  });

  it("toolbar actions synchronize state across all hydrated controllers", async () => {
    const first = addCard(payload(), { withTemplate: true });
    addCard(payload());
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    const layoutButton = first.host?.shadowRoot?.querySelector<HTMLButtonElement>(
      ".oc-diff-toolbar-button[aria-label='Switch to unified diff']",
    );
    expect(layoutButton).not.toBeNull();

    layoutButton?.click();

    for (const instance of diffMocks.MockFileDiff.instances) {
      expect(instance.setOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ diffStyle: "unified" }),
      );
      expect(instance.rerender).toHaveBeenCalledTimes(2);
    }

    const wrapButton = first.host?.shadowRoot?.querySelector<HTMLButtonElement>(
      ".oc-diff-toolbar-button[aria-label='Enable word wrap']",
    );
    wrapButton?.click();

    for (const instance of diffMocks.MockFileDiff.instances) {
      expect(instance.setOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ diffStyle: "unified", overflow: "wrap" }),
      );
      expect(instance.rerender).toHaveBeenCalledTimes(3);
    }
  });
});
