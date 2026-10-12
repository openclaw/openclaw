import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SemVer } from "semver";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexClientVersion } from "./client-version-api.js";
import { CODEX_APP_SERVER_VERSION } from "./src/app-server/version.js";

// mock-isolation: stands in an installed macOS desktop app on any host.
vi.mock("./src/app-server/desktop-app-paths.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveMacOSDesktopCodexAppServerCommandCandidates: () => [process.execPath],
}));

// Same slot test/setup.shared.ts seeds; the Codex plugin captured this object.
const installedState = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.codexInstalledAppServer")
] as {
  selection?: Promise<unknown>;
  selected?: { command: string; nativeCommand: string; version: string };
};

describe("Codex client version API", () => {
  afterEach(() => {
    installedState.selection = Promise.resolve(undefined);
    delete installedState.selected;
  });

  it("falls back to the managed Codex package pin", async () => {
    await expect(resolveCodexClientVersion({ env: {} })).resolves.toBe(CODEX_APP_SERVER_VERSION);
  });

  it("reports the installed Codex binary unless an explicit command wins", async () => {
    const version = new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version;
    const selected = {
      command: "/opt/codex/bin/codex",
      nativeCommand: "/opt/codex/bin/codex",
      version,
    };
    installedState.selection = Promise.resolve(selected);
    installedState.selected = selected;

    await expect(resolveCodexClientVersion({ env: {} })).resolves.toBe(version);
    await expect(
      resolveCodexClientVersion({ env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/custom/codex" } }),
    ).resolves.toBe(CODEX_APP_SERVER_VERSION);
    await expect(
      resolveCodexClientVersion({
        config: { plugins: { entries: { codex: { config: { appServer: { command: "/x" } } } } } },
        env: {},
      }),
    ).resolves.toBe(CODEX_APP_SERVER_VERSION);
  });

  it("keeps the bundled pin for an agent whose Codex home starts the desktop app", async () => {
    const version = new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version;
    const selected = {
      command: "/opt/codex/bin/codex",
      nativeCommand: "/opt/codex/bin/codex",
      version,
    };
    installedState.selection = Promise.resolve(selected);
    installedState.selected = selected;
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-client-agent-"));
    try {
      fs.mkdirSync(path.join(agentDir, "codex-home"));
      fs.writeFileSync(
        path.join(agentDir, "codex-home", "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );
      await expect(resolveCodexClientVersion({ env: {}, agentDir })).resolves.toBe(
        CODEX_APP_SERVER_VERSION,
      );
      fs.rmSync(path.join(agentDir, "codex-home", "config.toml"));
      await expect(resolveCodexClientVersion({ env: {}, agentDir })).resolves.toBe(version);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
