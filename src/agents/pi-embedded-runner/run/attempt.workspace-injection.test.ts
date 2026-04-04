import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveWorkspaceInjectionMode,
  shouldLoadBootstrapFiles,
} from "./attempt.workspace-injection.js";
import fs from "node:fs/promises";

vi.mock("node:fs/promises");

describe("resolveWorkspaceInjectionMode", () => {
  it("returns 'first-message-only' by default", () => {
    expect(resolveWorkspaceInjectionMode(undefined)).toBe("first-message-only");
    expect(resolveWorkspaceInjectionMode(null)).toBe("first-message-only");
    expect(resolveWorkspaceInjectionMode({})).toBe("first-message-only");
  });

  it("returns 'always' when configured", () => {
    const config = { agents: { defaults: { workspaceInjection: "always" } } };
    expect(resolveWorkspaceInjectionMode(config)).toBe("always");
  });

  it("returns 'first-message-only' for unknown values", () => {
    const config = { agents: { defaults: { workspaceInjection: "invalid" } } };
    expect(resolveWorkspaceInjectionMode(config)).toBe("first-message-only");
  });
});

describe("shouldLoadBootstrapFiles", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("loads bootstrap on first message (no session file)", async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT"));

    const result = await shouldLoadBootstrapFiles({
      sessionFile: "/tmp/test-session.json",
    });

    expect(result.shouldLoad).toBe(true);
    expect(result.hadSessionFile).toBe(false);
  });

  it("skips bootstrap on subsequent messages (session file exists)", async () => {
    vi.mocked(fs.stat).mockResolvedValue({} as any);

    const result = await shouldLoadBootstrapFiles({
      sessionFile: "/tmp/test-session.json",
    });

    expect(result.shouldLoad).toBe(false);
    expect(result.hadSessionFile).toBe(true);
  });

  it("always loads when config says 'always'", async () => {
    vi.mocked(fs.stat).mockResolvedValue({} as any);

    const result = await shouldLoadBootstrapFiles({
      sessionFile: "/tmp/test-session.json",
      config: { agents: { defaults: { workspaceInjection: "always" } } },
    });

    expect(result.shouldLoad).toBe(true);
    expect(result.hadSessionFile).toBe(true);
  });

  it("loads on first message even with 'always' config", async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT"));

    const result = await shouldLoadBootstrapFiles({
      sessionFile: "/tmp/test-session.json",
      config: { agents: { defaults: { workspaceInjection: "always" } } },
    });

    expect(result.shouldLoad).toBe(true);
    expect(result.hadSessionFile).toBe(false);
  });

  it("defaults to first-message-only with empty config", async () => {
    vi.mocked(fs.stat).mockResolvedValue({} as any);

    const result = await shouldLoadBootstrapFiles({
      sessionFile: "/tmp/test-session.json",
      config: {},
    });

    expect(result.shouldLoad).toBe(false);
    expect(result.hadSessionFile).toBe(true);
  });
});
