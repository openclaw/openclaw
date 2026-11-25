import { ChildProcess, spawn } from "node:child_process";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureExtensionRelayDaemonProcess } from "./extension-relay-daemon-spawn.js";
import { readExtensionRelayToken } from "./extension-relay/relay-auth.js";
import { getFreePort } from "./test-port.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
vi.mock("./extension-relay/relay-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extension-relay/relay-auth.js")>()),
  readExtensionRelayToken: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

const ENTRY = "/opt/openclaw/dist/extensions/browser/relay-daemon-entry.js";

describe("ensureExtensionRelayDaemonProcess", () => {
  it("skips when no relay credential exists", async () => {
    vi.mocked(readExtensionRelayToken).mockReturnValue(null);
    const status = await ensureExtensionRelayDaemonProcess({
      cfg: {},
      port: 18_799,
      entryPath: ENTRY,
    });
    expect(status).toBe("skipped");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns the daemon entry with the resolved port", async () => {
    const port = await getFreePort();
    const child = new ChildProcess();
    const unref = vi.spyOn(child, "unref");
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(readExtensionRelayToken).mockReturnValue("a".repeat(64));
    const status = await ensureExtensionRelayDaemonProcess({
      cfg: { browser: { profiles: { work: { driver: "extension", cdpPort: port } } } },
      port,
      entryPath: ENTRY,
    });
    expect(status).toBe("spawned");
    expect(spawn).toHaveBeenCalledWith(process.execPath, [ENTRY, "--port", String(port)], {
      detached: true,
      stdio: "ignore",
    });
    expect(unref).toHaveBeenCalledOnce();
  });
});

describe("relay port ownership", () => {
  it("leaves an existing listener alone and spawns only after it closes", async () => {
    vi.mocked(spawn).mockReturnValue(new ChildProcess());
    vi.mocked(readExtensionRelayToken).mockReturnValue("a".repeat(64));
    const params = {
      cfg: { browser: { profiles: { work: { driver: "extension" as const, cdpPort: 0 } } } },
      port: 0,
      entryPath: ENTRY,
    };
    await withServer(
      (_req, res) => res.end(),
      async (baseUrl) => {
        params.port = Number(new URL(baseUrl).port);
        params.cfg.browser.profiles.work.cdpPort = params.port;
        expect(await ensureExtensionRelayDaemonProcess(params)).toBe("running");
        expect(spawn).not.toHaveBeenCalled();
      },
    );
    expect(await ensureExtensionRelayDaemonProcess(params)).toBe("spawned");
    expect(spawn).toHaveBeenCalledOnce();
  });
});
