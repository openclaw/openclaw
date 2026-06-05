import type { FileDiffOptions } from "@pierre/diffs";
// @vitest-environment jsdom
// Diffs tests cover viewer client behavior: viewerState seeding, card hydration,
// toolbar toggles, ensureShadowRoot fallback, and error handling.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---
const mockFileDiffConstructor = vi.fn();
const mockSetOptions = vi.fn();
const mockRerender = vi.fn();
const mockHydrate = vi.fn();

vi.mock("@pierre/diffs", () => ({
  FileDiff: vi.fn(function (...args: unknown[]) {
    mockFileDiffConstructor(...args);
    const instance = {
      setOptions: mockSetOptions,
      rerender: mockRerender,
      hydrate: mockHydrate,
    };
    // Return the instance as `this` for constructor call
    Object.assign(this, instance);
    return this;
  }) as unknown as (typeof import("@pierre/diffs"))["FileDiff"],
  preloadHighlighter: vi.fn().mockResolvedValue(undefined),
  resolveLanguage: vi.fn(),
}));

// Mock language-hints to avoid real Shiki language resolution in jsdom.
const mockNormalizePayloadLangs = vi.fn((p: import("./types.js").DiffViewerPayload) =>
  Promise.resolve(p),
);
vi.mock("./language-hints.js", () => ({
  normalizeDiffViewerPayloadLanguages: mockNormalizePayloadLangs,
}));

// --- Helpers ---
function createValidPayload(overrides: Partial<import("./types.js").DiffViewerOptions> = {}) {
  const options: import("./types.js").DiffViewerOptions = {
    theme: { light: "pierre-light", dark: "pierre-dark" },
    diffStyle: "unified",
    diffIndicators: "bars",
    themeType: "dark",
    backgroundEnabled: true,
    overflow: "wrap",
    disableLineNumbers: false,
    expandUnchanged: false,
    unsafeCSS: "",
    ...overrides,
  };
  return {
    prerenderedHTML: "<div>mock</div>",
    options,
    langs: ["typescript"],
    fileDiff: {
      oldFile: {
        contents: "a",
        lang: "typescript",
      } as unknown as import("@pierre/diffs").FileDiffMetadata,
    },
  };
}

function injectCard(payload: Record<string, unknown>, withTemplateFallback = false): HTMLElement {
  const card = document.createElement("div");
  card.className = "oc-diff-card";

  const host = document.createElement("div");
  host.setAttribute("data-openclaw-diff-host", "");
  card.append(host);

  if (withTemplateFallback) {
    const tmpl = document.createElement("template");
    tmpl.setAttribute("shadowrootmode", "open");
    tmpl.innerHTML = "<div>shadow content</div>";
    host.append(tmpl);
  }

  const script = document.createElement("script");
  script.setAttribute("data-openclaw-diff-payload", "");
  script.setAttribute("type", "application/json");
  script.textContent = JSON.stringify(payload);
  card.append(script);

  document.body.append(card);
  return host;
}

// --- Setup ---
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  // Prevent auto-start on import
  Object.defineProperty(document, "readyState", {
    value: "loading",
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.resetModules();
});

// --- Tests ---
describe("hydrateViewer", () => {
  it("should seed viewerState from first payload options", async () => {
    injectCard(
      createValidPayload({
        themeType: "light",
        diffStyle: "split",
        backgroundEnabled: false,
        overflow: "scroll",
      }),
    );

    const { hydrateViewer, controllers } = await import("./viewer-client.js");

    expect(controllers).toHaveLength(0);
    await hydrateViewer();
    expect(controllers).toHaveLength(1);

    // syncDocumentTheme was called: body dataset.theme matches first payload
    expect(document.body.dataset.theme).toBe("light");

    // FileDiff constructor was called with options reflecting seeded state
    const createOpts = mockFileDiffConstructor.mock.calls[0][0] as FileDiffOptions<undefined>;
    expect(createOpts.themeType).toBe("light");
    expect(createOpts.diffStyle).toBe("split");
    expect(createOpts.disableBackground).toBe(true); // !backgroundEnabled
    expect(createOpts.overflow).toBe("scroll");
  });

  it("should hydrate multiple cards and populate controllers", async () => {
    injectCard(createValidPayload({ themeType: "dark" }));
    injectCard(createValidPayload({ themeType: "dark", diffStyle: "split" }));

    const { hydrateViewer, controllers } = await import("./viewer-client.js");
    await hydrateViewer();

    expect(controllers).toHaveLength(2);
    expect(mockFileDiffConstructor).toHaveBeenCalledTimes(2);
    expect(mockHydrate).toHaveBeenCalledTimes(2);
    expect(mockSetOptions).toHaveBeenCalledTimes(2);
    expect(mockRerender).toHaveBeenCalledTimes(2);
  });

  it("should skip cards with invalid payloads and log a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    injectCard(createValidPayload()); // valid
    injectCard({ prerenderedHTML: "bad", options: null, langs: [] }); // invalid shape

    const { hydrateViewer, controllers } = await import("./viewer-client.js");
    await hydrateViewer();

    expect(controllers).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping"), expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe("ensureShadowRoot fallback", () => {
  it("should attach shadow root from template when shadowRoot is absent", async () => {
    const host = injectCard(createValidPayload(), true); // with template fallback
    // Remove shadowRoot if jsdom auto-attached one (it doesn't, but be safe)
    if (host.shadowRoot) {
      // jsdom doesn't support declarative shadow DOM, so host.shadowRoot is null
    }

    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    // The ensureShadowRoot function should have attached the shadow root
    expect(host.shadowRoot).toBeTruthy();
    // Template content should be cloned into shadow root
    expect(host.shadowRoot?.innerHTML).toContain("shadow content");
    // Template should be removed from light DOM
    expect(host.querySelector("template")).toBeNull();
  });
});

describe("getHydrateProps branching", () => {
  it("should pass fileDiff when payload has fileDiff", async () => {
    const payload = createValidPayload();
    injectCard(payload);

    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    expect(mockHydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        fileDiff: expect.objectContaining({
          oldFile: expect.objectContaining({ contents: "a" }),
        }),
      }),
    );
  });

  it("should pass oldFile/newFile when payload lacks fileDiff", async () => {
    const payload = createValidPayload();
    // Remove fileDiff, add oldFile/newFile
    delete (payload as { fileDiff?: unknown }).fileDiff;
    payload.oldFile = { contents: "old content", lang: "text", name: "old.ts" };
    payload.newFile = { contents: "new content", lang: "text", name: "new.ts" };
    injectCard(payload);

    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    expect(mockHydrate).toHaveBeenCalledWith(
      expect.objectContaining({
        oldFile: expect.objectContaining({ contents: "old content" }),
        newFile: expect.objectContaining({ contents: "new content" }),
      }),
    );
  });
});

describe("toolbar toggle round-trip", () => {
  it("should toggle layout when layout button is clicked and sync all controllers", async () => {
    injectCard(createValidPayload({ themeType: "dark" }));
    injectCard(createValidPayload({ themeType: "dark" }));

    const { hydrateViewer, controllers } = await import("./viewer-client.js");
    await hydrateViewer();
    expect(controllers).toHaveLength(2);

    // Capture toolbar from the initial hydration setOptions call before clearing mocks
    const initialOpts = mockSetOptions.mock.calls[0]?.[0] as {
      renderHeaderMetadata?: () => HTMLElement;
    };
    const renderHeader = initialOpts?.renderHeaderMetadata;
    expect(renderHeader).toBeDefined();

    const toolbar = renderHeader!();
    expect(toolbar.className).toBe("oc-diff-toolbar");

    // Reset counts after initial hydration
    mockSetOptions.mockClear();
    mockRerender.mockClear();

    // Find the layout toggle button (first button in toolbar)
    const buttons = toolbar.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    // The first button is the layout toggle (unified -> split or split -> unified)
    const layoutButton = buttons[0];

    // Click the layout button to toggle from "unified" to "split"
    layoutButton.click();

    // After click, syncAllControllers should have been called,
    // meaning setOptions and rerender should have been called again for each controller
    expect(mockSetOptions).toHaveBeenCalledTimes(2); // once per controller
    expect(mockRerender).toHaveBeenCalledTimes(2);

    // The new options should have diffStyle "split"
    for (const call of mockSetOptions.mock.calls) {
      const opts = call[0] as { diffStyle?: string };
      expect(opts.diffStyle).toBe("split");
    }

    // Also verify syncDocumentTheme was called — document.body.dataset.theme unchanged
    expect(document.body.dataset.theme).toBe("dark");
  });

  it("should toggle theme and update document dataset", async () => {
    injectCard(createValidPayload({ themeType: "dark" }));

    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    // Capture toolbar from the hydration setOptions call before clearing mocks
    const initOpts = mockSetOptions.mock.calls[0]?.[0] as {
      renderHeaderMetadata?: () => HTMLElement;
    };
    const renderHeader = initOpts?.renderHeaderMetadata;
    expect(renderHeader).toBeDefined();

    const toolbar = renderHeader!();
    expect(toolbar).toBeDefined();

    mockSetOptions.mockClear();
    mockRerender.mockClear();

    // Last button is the theme toggle
    const buttons = toolbar!.querySelectorAll("button");
    const themeButton = buttons[buttons.length - 1];

    // Initially dark, clicking toggles to light
    themeButton.click();

    expect(document.body.dataset.theme).toBe("light");
    expect(mockSetOptions).toHaveBeenCalled();

    // Verify the new options have themeType "light"
    for (const call of mockSetOptions.mock.calls) {
      const renderOpts = call[0] as { themeType?: string };
      expect(renderOpts.themeType).toBe("light");
    }
  });
});
