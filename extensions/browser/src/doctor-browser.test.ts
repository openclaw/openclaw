import { describe, expect, it, vi } from "vitest";
import { noteChromeMcpBrowserReadiness } from "./doctor-browser.js";

describe("noteChromeMcpBrowserReadiness", () => {
  it("warns when managed browser profiles have no local executable", async () => {
    const noteFn = vi.fn();

    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          profiles: {
            openclaw: { color: "#FF4500" },
          },
        },
      },
      {
        noteFn,
        platform: "linux",
        resolveManagedExecutable: () => null,
      },
    );

    expect(noteFn).toHaveBeenCalledWith(
      expect.stringContaining("No Chromium-based browser executable was found on this host"),
      "Browser",
    );
  });

  it("warns when managed browser launch needs display and no-sandbox adjustments", async () => {
    const noteFn = vi.fn();

    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          headless: false,
          noSandbox: false,
          profiles: {
            openclaw: { color: "#FF4500" },
          },
        },
      },
      {
        noteFn,
        platform: "linux",
        env: {},
        getUid: () => 0,
        resolveManagedExecutable: () => ({ kind: "chromium", path: "/usr/bin/chromium" }),
      },
    );

    expect(noteFn).toHaveBeenCalledWith(
      expect.stringContaining("No DISPLAY or WAYLAND_DISPLAY is set"),
      "Browser",
    );
    expect(noteFn).toHaveBeenCalledWith(
      expect.stringContaining("browser.noSandbox: true"),
      "Browser",
    );
  });

  it("still reports Chrome MCP existing-session readiness", async () => {
    const noteFn = vi.fn();

    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          profiles: {
            user: {
              driver: "existing-session",
              color: "#00AA00",
            },
          },
        },
      },
      {
        noteFn,
        platform: "linux",
        resolveChromeExecutable: () => ({ path: "/usr/bin/google-chrome" }),
        readVersion: () => "Google Chrome 145.0.0.0",
      },
    );

    expect(noteFn).toHaveBeenCalledWith(
      expect.stringContaining("Chrome MCP existing-session is configured"),
      "Browser",
    );
  });
});
