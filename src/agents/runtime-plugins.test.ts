import { afterEach, describe, expect, test, vi } from "vitest";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

import { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";

afterEach(() => {
  loadOpenClawPlugins.mockReset();
});

describe("ensureRuntimePluginsLoaded", () => {
  test("opts into shared runtime inheritance", () => {
    const config = { plugins: { enabled: true } };

    ensureRuntimePluginsLoaded({
      config,
      workspaceDir: "/tmp/workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        inheritSharedRuntimeOptions: true,
      }),
    );
  });
});
