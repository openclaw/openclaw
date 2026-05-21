/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

const disableAutoStartKey = Symbol.for("openclaw.diffs.disableAutoStart");
(globalThis as typeof globalThis & Record<symbol, unknown>)[disableAutoStartKey] = true;

const { fileDiffHydrateMock, fileDiffRerenderMock, fileDiffSetOptionsMock, preloadHighlighterMock } =
  vi.hoisted(() => ({
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

function renderCard(): void {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<section class="oc-diff-card">
      <div data-openclaw-diff-host></div>
      <script type="application/json" data-openclaw-diff-payload>${viewerPayload}</script>
    </section>`,
  );
}

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
});
