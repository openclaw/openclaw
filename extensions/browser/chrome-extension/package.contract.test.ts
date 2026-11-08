import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const extensionDir = path.dirname(fileURLToPath(import.meta.url));

describe("simplified Chrome extension package", () => {
  it("declares only relay, access, storage, watchdog, and native bootstrap permissions", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));

    expect(manifest.permissions).toEqual([
      "debugger",
      "tabs",
      "tabGroups",
      "storage",
      "alarms",
      "nativeMessaging",
    ]);
    expect(manifest).not.toHaveProperty("commands");
    expect(manifest.options_ui).toEqual({ page: "options.html", open_in_tab: true });
  });

  it("ships redacted retired-custody recovery guidance", () => {
    const options = fs.readFileSync(path.join(extensionDir, "options.html"), "utf8");
    const popup = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");

    expect(options).toContain("Automation is paused to protect a pre-upgrade copilot session.");
    expect(options).toContain("Confirm old runs are finished");
    expect(options).toContain("Disconnect and disable automatic setup");
    expect(options).toContain("Use local OpenClaw");
    expect(popup).toContain("Automation paused; open Settings");
    expect(options).not.toMatch(/copilotSessionRegistryV1|sessionId|sessionKey|deviceToken/u);
  });
});

describe("Chrome extension asset copy", () => {
  it.each(["same", "ancestor", "descendant", "sibling"])(
    "preserves source files with %s output",
    (kind) => {
      const root = tempDirs.make("openclaw-chrome-copy-");
      const source = path.join(root, "source");
      const output =
        kind === "same"
          ? source
          : kind === "ancestor"
            ? root
            : kind === "descendant"
              ? path.join(source, "dist")
              : path.join(root, "source-dist");
      fs.mkdirSync(source);
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(source, "manifest.json"), '{"name":"fixture"}');
      fs.writeFileSync(path.join(output, "old.txt"), "previous output");
      const result = spawnSync(
        process.execPath,
        [path.join(extensionDir, "../scripts/copy-chrome-extension.mjs")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_CHROME_EXT_SRC_DIR: source,
            OPENCLAW_CHROME_EXT_OUT_DIR: output,
          },
        },
      );
      expect(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).toBe(
        '{"name":"fixture"}',
      );
      if (kind === "sibling") {
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(path.join(output, "manifest.json"), "utf8")).toBe(
          '{"name":"fixture"}',
        );
        expect(fs.existsSync(path.join(output, "old.txt"))).toBe(false);
      } else {
        expect(fs.readFileSync(path.join(output, "old.txt"), "utf8")).toBe("previous output");
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("must not overlap");
      }
    },
  );
});
