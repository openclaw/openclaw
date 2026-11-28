import path from "node:path";
import { getWindowsInstallRoots } from "openclaw/plugin-sdk/test-env";
import { withMockedWindowsPlatform } from "openclaw/plugin-sdk/test-node-mocks";
import { describe, expect, it } from "vitest";

const { resolveGogServeInvocation } = await import("./gmail.js");

describe("resolveGogServeInvocation on Windows", () => {
  it("wraps spaced gog .cmd paths in an outer cmd.exe command line", async () => {
    await withMockedWindowsPlatform(async () => {
      const invocation = resolveGogServeInvocation(
        ["gmail", "watch", "serve", "--account", "me@example.com"],
        "C:\\Program Files\\gog\\gog.cmd",
      );

      expect(invocation).toEqual({
        command: path.win32.join(getWindowsInstallRoots().systemRoot, "System32", "cmd.exe"),
        args: [
          "/d",
          "/s",
          "/c",
          '""C:\\Program Files\\gog\\gog.cmd" "gmail" "watch" "serve" "--account" "me@example.com""',
        ],
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    });
  });

  it("quotes caret arguments for gog .cmd wrappers", async () => {
    await withMockedWindowsPlatform(async () => {
      const invocation = resolveGogServeInvocation(
        ["gmail", "watch", "serve", "--label", "release/^1"],
        "gog.cmd",
      );

      expect(invocation.args).toEqual([
        "/d",
        "/s",
        "/c",
        '""gog.cmd" "gmail" "watch" "serve" "--label" "release/^1""',
      ]);
      expect(invocation.windowsVerbatimArguments).toBe(true);
    });
  });
});
