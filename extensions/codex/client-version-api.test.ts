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

  // The stand-in binaries are POSIX shell scripts. Each test uses fresh paths, so
  // remembered answers never carry over between tests.
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
    // Like npx: a bare --version prints the launcher's own version; otherwise it
    // runs the program named by its arguments.
    const fakeLauncher = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-client-launcher-"));
      dirs.push(dir);
      const command = path.join(dir, "launcher");
      fs.writeFileSync(
        command,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "11.19.1"; exit 0; fi\nexec "$@"\n',
        { mode: 0o755 },
      );
      return command;
    };
    const configWith = (command: string, args?: string[]) => ({
      plugins: { entries: { codex: { config: { appServer: { command, args } } } } },
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
      // A wrapper that answers with its own version is not Codex.
      await expect(
        resolveCodexClientVersion({ config: configWith(fakeCodex("11.19.1")), env: process.env }),
      ).resolves.toBe(CODEX_APP_SERVER_VERSION);
      await expect(
        resolveCodexClientVersion({
          config: configWith(fakeCodex("codex-cli 0.999.0", 1)),
          env: process.env,
        }),
      ).resolves.toBe(CODEX_APP_SERVER_VERSION);
    });

    it("asks Codex through the configured launcher, not the launcher itself", async () => {
      const launcher = fakeLauncher();
      const codex = fakeCodex("codex-cli 0.999.0");
      await expect(
        resolveCodexClientVersion({
          config: configWith(launcher, [codex, "app-server", "--listen", "stdio://"]),
          env: process.env,
        }),
      ).resolves.toBe("0.999.0");
      // Args that name no app-server subcommand do not identify the launched program.
      await expect(
        resolveCodexClientVersion({
          config: configWith(launcher, [codex, "serve"]),
          env: process.env,
        }),
      ).resolves.toBe(CODEX_APP_SERVER_VERSION);
      // A proxy joins a running app-server whose version this binary cannot vouch for.
      await expect(
        resolveCodexClientVersion({
          config: configWith(codex, ["app-server", "proxy"]),
          env: process.env,
        }),
      ).resolves.toBe(CODEX_APP_SERVER_VERSION);
    });

    it("keeps answers for a bare command apart per PATH", async () => {
      const older = path.dirname(fakeCodex("codex-cli 0.999.0"));
      const newer = path.dirname(fakeCodex("codex-cli 0.999.1"));
      const config = configWith("codex");
      await expect(
        resolveCodexClientVersion({ config, env: { ...process.env, PATH: older } }),
      ).resolves.toBe("0.999.0");
      await expect(
        resolveCodexClientVersion({ config, env: { ...process.env, PATH: newer } }),
      ).resolves.toBe("0.999.1");
    });

    it("keeps an answer for the process and retries a failed check", async () => {
      const command = fakeCodex("codex-cli 0.999.0");
      const config = configWith(command);
      await expect(resolveCodexClientVersion({ config, env: process.env })).resolves.toBe(
        "0.999.0",
      );
      // Running app-servers keep the old binary after an in-place upgrade.
      writeFakeCodex(command, "codex-cli 0.999.1");
      await expect(resolveCodexClientVersion({ config, env: process.env })).resolves.toBe(
        "0.999.0",
      );

      const failing = fakeCodex("codex-cli 0.999.2", 1);
      await expect(
        resolveCodexClientVersion({ config: configWith(failing), env: process.env }),
      ).resolves.toBe(CODEX_APP_SERVER_VERSION);
      writeFakeCodex(failing, "codex-cli 0.999.2");
      await expect(
        resolveCodexClientVersion({ config: configWith(failing), env: process.env }),
      ).resolves.toBe("0.999.2");
    });
  });
});
