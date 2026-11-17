import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SemVer } from "semver";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_CODEX_VERSION_TTL_MS,
  resetCustomCodexClientVersionsForTest,
  resolveCodexClientVersion,
} from "./client-version-api.js";
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
    resetCustomCodexClientVersionsForTest();
    vi.restoreAllMocks();
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

  // The stand-in binaries are POSIX shell scripts.
  describe.skipIf(process.platform === "win32")("custom stdio command", () => {
    const dirs: string[] = [];
    const fakeCodex = (output: string, exitCode = 0) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-client-cmd-"));
      dirs.push(dir);
      const command = path.join(dir, "codex");
      writeFakeCodex(command, output, exitCode);
      return command;
    };
    const writeFakeCodex = (command: string, output: string, exitCode = 0) => {
      fs.writeFileSync(command, `#!/bin/sh\necho "${output}"\nexit ${exitCode}\n`, { mode: 0o755 });
    };
    const configWith = (command: string) => ({
      plugins: { entries: { codex: { config: { appServer: { command } } } } },
    });

    afterEach(() => {
      for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports the configured binary's own version instead of the bundled pin", async () => {
      const command = fakeCodex("codex-cli 0.999.0");
      await expect(
        resolveCodexClientVersion({ config: configWith(command), env: process.env }),
      ).resolves.toBe("0.999.0");
      await expect(
        resolveCodexClientVersion({
          env: { ...process.env, OPENCLAW_CODEX_APP_SERVER_BIN: command },
        }),
      ).resolves.toBe("0.999.0");
    });

    it("keeps the bundled pin when the version is unreadable and nothing is known", async () => {
      await expect(
        resolveCodexClientVersion({
          config: configWith(fakeCodex("not a version")),
          env: process.env,
        }),
      ).resolves.toBe(CODEX_APP_SERVER_VERSION);
      await expect(
        resolveCodexClientVersion({
          config: configWith(fakeCodex("codex-cli 0.999.0", 1)),
          env: process.env,
        }),
      ).resolves.toBe(CODEX_APP_SERVER_VERSION);
    });

    it("reuses the last answer while a check fails and picks up an in-place upgrade", async () => {
      let nowMs = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const command = fakeCodex("codex-cli 0.999.0");
      const config = configWith(command);
      await expect(resolveCodexClientVersion({ config, env: process.env })).resolves.toBe(
        "0.999.0",
      );

      // Within the TTL the binary is not run again.
      writeFakeCodex(command, "codex-cli 0.999.1");
      await expect(resolveCodexClientVersion({ config, env: process.env })).resolves.toBe(
        "0.999.0",
      );

      // A failed check after the TTL (binary missing mid-reinstall) keeps the last answer.
      fs.rmSync(command);
      nowMs += CUSTOM_CODEX_VERSION_TTL_MS;
      await expect(resolveCodexClientVersion({ config, env: process.env })).resolves.toBe(
        "0.999.0",
      );

      // The upgraded binary is reported on the next check.
      writeFakeCodex(command, "codex-cli 0.999.1");
      await expect(resolveCodexClientVersion({ config, env: process.env })).resolves.toBe(
        "0.999.1",
      );
    });
  });
});
