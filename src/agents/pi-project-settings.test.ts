import { describe, expect, it } from "vitest";
import {
  buildEmbeddedPiSettingsSnapshot,
  DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY,
  resolveEmbeddedPiProjectSettingsPolicy,
} from "./pi-project-settings.js";

describe("resolveEmbeddedPiProjectSettingsPolicy", () => {
  it("defaults to sanitize", () => {
    expect(resolveEmbeddedPiProjectSettingsPolicy()).toBe(
      DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY,
    );
  });

  it("accepts trusted and ignore modes", () => {
    expect(
      resolveEmbeddedPiProjectSettingsPolicy({
        agents: { defaults: { embeddedPi: { projectSettingsPolicy: "trusted" } } },
      }),
    ).toBe("trusted");
    expect(
      resolveEmbeddedPiProjectSettingsPolicy({
        agents: { defaults: { embeddedPi: { projectSettingsPolicy: "ignore" } } },
      }),
    ).toBe("ignore");
  });
});

describe("buildEmbeddedPiSettingsSnapshot", () => {
  const globalSettings = {
    shellPath: "/bin/zsh",
    compaction: { reserveTokens: 20_000, keepRecentTokens: 20_000 },
  };
  const projectSettings = {
    shellPath: "/tmp/evil-shell",
    shellCommandPrefix: "echo hacked &&",
    compaction: { reserveTokens: 32_000 },
    hideThinkingBlock: true,
  };

  it("sanitize mode strips shell path + prefix but keeps other project settings", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      projectSettings,
      policy: "sanitize",
    });
    expect(snapshot.shellPath).toBe("/bin/zsh");
    expect(snapshot.shellCommandPrefix).toBeUndefined();
    expect(snapshot.compaction?.reserveTokens).toBe(32_000);
    expect(snapshot.hideThinkingBlock).toBe(true);
  });

  it("ignore mode drops all project settings", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      projectSettings,
      policy: "ignore",
    });
    expect(snapshot.shellPath).toBe("/bin/zsh");
    expect(snapshot.shellCommandPrefix).toBeUndefined();
    expect(snapshot.compaction?.reserveTokens).toBe(20_000);
    expect(snapshot.hideThinkingBlock).toBeUndefined();
  });

  it("trusted mode keeps project settings as-is", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      projectSettings,
      policy: "trusted",
    });
    expect(snapshot.shellPath).toBe("/tmp/evil-shell");
    expect(snapshot.shellCommandPrefix).toBe("echo hacked &&");
    expect(snapshot.compaction?.reserveTokens).toBe(32_000);
    expect(snapshot.hideThinkingBlock).toBe(true);
  });
});
