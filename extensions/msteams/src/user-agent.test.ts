import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the runtime before importing buildUserAgent
const mockRuntime = {
  version: "2026.3.19",
};

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: vi.fn(() => mockRuntime),
}));

import { getMSTeamsRuntime } from "./runtime.js";
import { buildUserAgent, resetUserAgentCache } from "./user-agent.js";

describe("buildUserAgent", () => {
  beforeEach(() => {
    resetUserAgentCache();
    vi.mocked(getMSTeamsRuntime).mockReturnValue(mockRuntime as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns teams.ts[apps]/<sdk> OpenClaw/<version> format", () => {
    const ua = buildUserAgent();
    expect(ua).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/2026\.3\.19$/);
  });

  it("reflects the runtime version", () => {
    vi.mocked(getMSTeamsRuntime).mockReturnValue({ version: "1.2.3" } as never);
    const ua = buildUserAgent();
    expect(ua).toMatch(/OpenClaw\/1\.2\.3$/);
  });

  it("returns OpenClaw/unknown when runtime is not initialized", () => {
    vi.mocked(getMSTeamsRuntime).mockImplementation(() => {
      throw new Error("MSTeams runtime not initialized");
    });
    const ua = buildUserAgent();
    expect(ua).toMatch(/OpenClaw\/unknown$/);
    // SDK version should still be present
    expect(ua).toMatch(/^teams\.ts\[apps\]\//);
  });
});
