import { afterEach, describe, expect, it } from "vitest";
import { isCanvasHostEnabled, parseCanvasPluginConfig, resolveCanvasHostConfig } from "./config.js";

describe("Canvas presenter config", () => {
  const originalSkipCanvasHost = process.env.OPENCLAW_SKIP_CANVAS_HOST;

  afterEach(() => {
    if (originalSkipCanvasHost === undefined) {
      delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
    } else {
      process.env.OPENCLAW_SKIP_CANVAS_HOST = originalSkipCanvasHost;
    }
  });

  it("parses and resolves only host.enabled", () => {
    expect(
      parseCanvasPluginConfig({
        host: { enabled: false, root: "~/canvas", port: 18793, liveReload: true },
      }),
    ).toEqual({ host: { enabled: false } });
    expect(
      resolveCanvasHostConfig({
        config: {
          plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
        },
      }),
    ).toEqual({ enabled: false });
  });

  it("honors the internal skip-host test switch", () => {
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
    expect(isCanvasHostEnabled()).toBe(false);
  });
});
