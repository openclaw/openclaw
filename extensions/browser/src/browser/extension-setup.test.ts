import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserExtensionStatus } from "./extension-install.js";
import { runBrowserExtensionSetup } from "./extension-setup.js";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  install: vi.fn(),
  readToken: vi.fn(),
  connect: vi.fn(),
  status: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./extension-install.js", () => ({
  browserExtensionStatus: mocks.inspect,
  installChromeExtensionBootstrap: mocks.install,
}));
vi.mock("./extension-relay/relay-auth.js", () => ({ readExtensionRelayToken: mocks.readToken }));
vi.mock("./extension-relay/owner-client.js", () => ({
  RelayOwnerClient: { connect: mocks.connect },
}));

function installation(): BrowserExtensionStatus {
  return {
    platform: "linux",
    platformSupport: "automatic",
    installedCopy: { path: "/private/copy", present: true, owned: true },
    bundledPath: "/private/bundle",
    approvedPaths: [],
    discovered: [],
    storeDiscovered: [],
    storeInstallRequests: [],
    registrations: [
      {
        product: "chrome",
        browser: "Chrome",
        manifestPath: "/private/manifest",
        extensionIds: [],
        state: "owned",
      },
    ],
    manualSetupRequired: true,
    issues: [],
  };
}
const options = { bundledDir: "/bundle", pluginRoot: "/plugin", cfg: {} };
describe("host-local Chrome setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspect.mockResolvedValue(installation());
    mocks.install.mockResolvedValue(installation());
    mocks.readToken.mockReturnValue("synthetic-private-relay-key");
    mocks.connect.mockResolvedValue({ status: mocks.status, close: mocks.close });
    mocks.status.mockResolvedValue({ ready: true, identity: { extensionVersion: "2.3.0" } });
    mocks.close.mockResolvedValue(undefined);
  });

  it("inspection never installs, probes, or exposes filesystem or credential material", async () => {
    const result = await runBrowserExtensionSetup({ ...options, action: "inspect" });
    expect(result).toMatchObject({
      phase: "needs_browser_action",
      nextAction: "install_from_store",
      connection: { state: "not_checked" },
      target: { kind: "local-host", profile: "chrome" },
    });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.readToken).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("/private");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-relay-key");
  });

  it("preserves the owned non-default profile when desktop setup omits a selector", async () => {
    const saved = installation();
    saved.registrations[0]!.browserProfile = "work";
    mocks.inspect.mockResolvedValue(saved);
    mocks.install.mockResolvedValue(saved);
    const result = await runBrowserExtensionSetup({
      ...options,
      action: "install",
      cfg: { browser: { profiles: { work: { driver: "extension", cdpPort: 19444 } } } },
    });
    expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({ browserProfile: "work" }));
    expect(result.target).toMatchObject({ profile: "work", relayPort: 19444 });
    expect(mocks.readToken).not.toHaveBeenCalled();
  });

  it("does not replace an unavailable saved profile or choose between conflicting registrations", async () => {
    const saved = installation();
    saved.registrations[0]!.browserProfile = "work";
    mocks.inspect.mockResolvedValue(saved);
    await expect(runBrowserExtensionSetup({ ...options, action: "install" })).rejects.toThrow(
      "existing extension browser profile",
    );
    saved.registrations.push({
      ...saved.registrations[0]!,
      product: "chromium",
      browserProfile: "other",
    });
    await expect(runBrowserExtensionSetup({ ...options, action: "install" })).rejects.toThrow(
      "registrations disagree",
    );
    expect(mocks.install).not.toHaveBeenCalled();
    await runBrowserExtensionSetup({ ...options, action: "install", profile: "chrome" });
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({ browserProfile: "chrome" }),
    );
  });

  it("keeps actual Chrome approval separate from automatic pairing", async () => {
    mocks.install.mockResolvedValue({
      ...installation(),
      storeDiscovered: [{ product: "chrome", enabled: false, awaitingApproval: true }],
    });
    const result = await runBrowserExtensionSetup({ ...options, action: "install" });
    expect(result).toMatchObject({
      phase: "needs_browser_action",
      reason: "chrome_approval_required",
      nextAction: "approve_extension",
    });
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.readToken).not.toHaveBeenCalled();
  });

  it("proves the exact local profile even when configured Gateway uses an SSH loopback", async () => {
    const result = await runBrowserExtensionSetup({
      ...options,
      action: "verify",
      profile: "work",
      cfg: {
        gateway: { mode: "remote", remote: { url: "ws://127.0.0.1:18789" } },
        browser: { profiles: { work: { driver: "extension", cdpPort: 19444 } } },
      },
    });
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "work", port: 19444 }),
    );
    expect(result).toMatchObject({
      phase: "ready",
      connection: { state: "connected" },
      target: { profile: "work", relayPort: 19444 },
    });
    expect(result).not.toHaveProperty("gatewayLocal");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("synthetic-private-relay-key");
  });

  it("does not mint a key or claim connection when none exists", async () => {
    mocks.readToken.mockReturnValue(null);
    const result = await runBrowserExtensionSetup({ ...options, action: "verify" });
    expect(result.connection.state).toBe("unavailable");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("distinguishes connected relay without an extension from a missing listener", async () => {
    mocks.status.mockResolvedValue({ ready: false, identity: null });
    const waiting = await runBrowserExtensionSetup({ ...options, action: "verify" });
    expect(waiting.connection.state).toBe("waiting_for_extension");
    mocks.connect.mockRejectedValue(new Error("synthetic-private-relay-key"));
    const missing = await runBrowserExtensionSetup({ ...options, action: "verify" });
    expect(missing.connection.state).toBe("unavailable");
    expect(JSON.stringify(missing)).not.toContain("synthetic-private-relay-key");
  });

  it("rejects invalid profile and canceled request before install", async () => {
    await expect(
      runBrowserExtensionSetup({ ...options, action: "install", profile: "openclaw" }),
    ).rejects.toThrow("extension browser profile");
    await expect(
      runBrowserExtensionSetup({ ...options, action: "install", signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(mocks.install).not.toHaveBeenCalled();
  });
});
