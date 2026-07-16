import { beforeEach, describe, expect, it, vi } from "vitest";

const warnMock = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    subsystem: "agents/tools",
    isEnabled: vi.fn(() => false),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(() => ({ warn: vi.fn() })),
  })),
}));

type DeprecatedTimeoutBehaviorTestApi = {
  reset: () => void;
  warn: (pluginId: string) => void;
};

async function loadTestApi(): Promise<DeprecatedTimeoutBehaviorTestApi> {
  await import("./agent-tools.before-tool-call.js");
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.warnDeprecatedApprovalTimeoutBehaviorTestApi")
  ];
  return api as DeprecatedTimeoutBehaviorTestApi;
}

describe("deprecated approval timeout behavior warning cache", () => {
  beforeEach(() => {
    vi.resetModules();
    warnMock.mockClear();
  });

  it("deduplicates warnings for the same plugin id", async () => {
    const api = await loadTestApi();
    api.reset();
    api.warn("plugin-a");
    api.warn("plugin-a");
    api.warn("plugin-a");

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("plugin 'plugin-a' sets deprecated requireApproval.timeoutBehavior"),
    );
  });

  it("caps the cache at 1024 entries and re-warns evicted plugin ids", async () => {
    const api = await loadTestApi();
    api.reset();

    // Fill the cache to exactly its max size.
    for (let i = 0; i < 1024; i += 1) {
      api.warn(`plugin-${i}`);
    }
    expect(warnMock).toHaveBeenCalledTimes(1024);

    // A recent plugin should still be deduplicated.
    warnMock.mockClear();
    api.warn("plugin-1023");
    expect(warnMock).not.toHaveBeenCalled();

    // Overflow the cache by one entry, evicting the oldest plugin.
    api.warn("plugin-1024");
    expect(warnMock).toHaveBeenCalledTimes(1);

    // The oldest plugin should now be warned again.
    api.warn("plugin-0");
    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(warnMock).toHaveBeenLastCalledWith(
      expect.stringContaining("plugin 'plugin-0' sets deprecated requireApproval.timeoutBehavior"),
    );
  });
});
