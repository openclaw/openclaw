import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCrabboxMacosDesktopEndpoint,
  createCrabboxMacosDesktopSetup,
  createCrabboxMacosGuiLaunchScript,
} from "./crabbox-worker-desktop-macos.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const leaseId = "cbx_macos_fixture";
const wallpaper = Buffer.from("synthetic wallpaper");
type Readiness = "ready" | "wrong-account" | "no-gui" | "invalid-signature" | "ad-hoc" | "old-app";

function desktopFixture(readiness: Readiness) {
  const root = tempDirs.make("crabbox-macos-desktop-");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const provider = path.join(root, "provider");
  const desktop = path.join(provider, "openclaw-workers", leaseId);
  const profile = path.join(desktop, "browser-profile");
  const workingDirectory = path.join(root, "runtime directory");
  const app = path.join(root, "OpenClawCloudWorker.app");
  const browser = path.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome");
  for (const directory of [bin, home, provider, workingDirectory, path.dirname(browser)]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(provider, "vnc.password"), "synthetic-vnc-password\n");
  for (const suffix of ["Contents/MacOS/OpenClaw", "Contents/Resources/cua-driver"]) {
    const executable = path.join(app, suffix);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  }
  fs.writeFileSync(
    browser,
    '#!/bin/bash\nprintf "launch\\n" >> "$FIXTURE_ROOT/launches"\nprintf "%s\\n" "$FIXTURE_EFFECTIVE_UID" "$FIXTURE_GUI_CONTEXT" "$HOME" "$TMPDIR" "$PATH" "$PWD" "${INHERITED_CANARY-unset}" > "$FIXTURE_ROOT/browser-context"\ntouch "$FIXTURE_ROOT/cdp-ready"\nexec /bin/sleep 30\n',
    { mode: 0o700 },
  );
  const commands: Record<string, string> = {
    // A tail larger than a pipe buffer exposes signature readers that close before printf finishes.
    codesign: `if [ "$1" = --verify ]; then [ "$FIXTURE_READINESS" != invalid-signature ]; exit; fi
if [ "$FIXTURE_READINESS" = ad-hoc ]; then echo Signature=adhoc; else printf 'Authority=Developer ID Application: Fixture\\nTeamIdentifier=ABCDEFGHIJ\\n'; fi
if [ "$FIXTURE_READINESS" = ready ]; then printf '%131072s\\n' 'synthetic codesign diagnostic'; fi`,
    PlistBuddy: `case "$2" in
  'Print :CFBundleExecutable') echo OpenClaw ;;
  'Print :CFBundleIdentifier') echo ai.openclaw.cloud-worker ;;
  'Print :OpenClawCloudWorkerHostVersion') if [ "$FIXTURE_READINESS" = old-app ]; then echo 0; else echo 1; fi ;;
  *) exit 1 ;;
esac`,
    id: `case "$1" in -u) echo "\${FIXTURE_EFFECTIVE_UID-501}" ;; -un) echo fixture ;; -gn) echo staff ;; *) exit 1 ;; esac`,
    stat: "echo 501",
    launchctl: `if [ "$1" = print ]; then [ "$FIXTURE_READINESS" != no-gui ]; exit; fi
[ "$1" = asuser ] && [ "$2" = 501 ] && [ "$FIXTURE_EFFECTIVE_UID" = 0 ] || { echo 'SSH GUI adoption requires root' >&2; exit 1; }
export FIXTURE_GUI_CONTEXT=adopted
shift 2
exec "$@"`,
    dscl: 'printf "NFSHomeDirectory: %s\\n" "$FIXTURE_HOME"',
    getconf: 'printf "%s/tmp\\n" "$FIXTURE_ROOT"',
    sudo: `if [ "$1 $2" = '-n --' ]; then
  export FIXTURE_EFFECTIVE_UID=0
  shift 2
elif [ "$1 $2 $3 $4" = '-n -u #501 --' ]; then
  [ "$FIXTURE_EFFECTIVE_UID" = 0 ] && [ "$FIXTURE_GUI_CONTEXT" = adopted ]
  export FIXTURE_EFFECTIVE_UID=501
  shift 4
else exit 1; fi
exec "$@"`,
    env: `test "$1" = -i
shift
exec /usr/bin/env -i FIXTURE_ROOT="$FIXTURE_ROOT" FIXTURE_HOME="$FIXTURE_HOME" FIXTURE_NODE="$FIXTURE_NODE" FIXTURE_READINESS="$FIXTURE_READINESS" FIXTURE_BROWSER="$FIXTURE_BROWSER" FIXTURE_PROFILE="$FIXTURE_PROFILE" FIXTURE_EFFECTIVE_UID="$FIXTURE_EFFECTIVE_UID" FIXTURE_GUI_CONTEXT="$FIXTURE_GUI_CONTEXT" "$@"`,
    open: 'printf "%s\\n" "$FIXTURE_EFFECTIVE_UID" "$FIXTURE_GUI_CONTEXT" "$HOME" "$TMPDIR" "$PATH" "$PWD" "${INHERITED_CANARY-unset}" > "$FIXTURE_ROOT/terminal-context"\nprintf "%s\\n" "$@" > "$FIXTURE_ROOT/gui-arguments"',
    install: `args=()
while [ "$#" -gt 0 ]; do
  case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
done
exec /usr/bin/install "\${args[@]}"`,
    base64: `exec "$FIXTURE_NODE" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(Buffer.from(s,"base64")))'`,
    lockf: 'shift 3; shift; exec "$@"',
    curl: '[ -f "$FIXTURE_ROOT/cdp-ready" ]',
    lsof: "printf 'p1\\nn127.0.0.1:9222\\n'",
    ps: `if [ "$4" = uid= ]; then echo 501; exit; fi
printf '%s --user-data-dir=%s --remote-debugging-port=9222 about:blank\\n' "$FIXTURE_BROWSER" "$FIXTURE_PROFILE"`,
  };
  for (const [name, body] of Object.entries(commands)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`, {
      mode: 0o700,
    });
  }
  const remapCommands = (source: string) =>
    source.replaceAll(
      /\/(?:usr\/(?:bin|sbin|libexec)|bin)\/([A-Za-z0-9]+)/gu,
      (command, name: string) => (Object.hasOwn(commands, name) ? path.join(bin, name) : command),
    );
  const script = remapCommands(
    createCrabboxMacosDesktopSetup(
      leaseId,
      wallpaper.toString("base64"),
      readiness === "wrong-account" ? "another-account" : "fixture",
    )
      .replaceAll("/Applications/OpenClawCloudWorker.app", app)
      .replaceAll("/var/db/crabbox", provider)
      .replaceAll("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", browser),
  );
  // Execute the generated setup and launchers; only the OS commands and roots are fixtures.
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    FIXTURE_ROOT: root,
    FIXTURE_HOME: home,
    FIXTURE_NODE: process.execPath,
    FIXTURE_READINESS: readiness,
    FIXTURE_BROWSER: browser,
    FIXTURE_PROFILE: profile,
    INHERITED_CANARY: "must-not-reach-gui",
  };
  const run = (command: string, args: string[], input?: string) =>
    spawnSync(command, args, {
      input,
      env,
      cwd: workingDirectory,
      encoding: "utf8",
      timeout: 5_000,
    });
  const result = run("/bin/bash", [], script);
  return {
    result,
    root,
    desktop,
    expectedContext: [
      "501",
      "adopted",
      home,
      path.join(root, "tmp"),
      env.PATH,
      workingDirectory,
      "unset",
      "",
    ].join("\n"),
    repeat: () => run(path.join(desktop, "browser"), []),
    terminal: () => run(path.join(desktop, "terminal"), []),
    host: () =>
      run("/bin/bash", [
        "-c",
        remapCommands(createCrabboxMacosGuiLaunchScript()),
        "openclaw-gui",
        path.join(bin, "open"),
        "--cloud-worker-host",
        "--display-name",
        "Worker with spaces",
      ]),
    cleanup: () => {
      const pidFile = path.join(profile, "browser.pid");
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 1) {
          try {
            process.kill(pid, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
        }
      }
    },
  };
}

describe("Crabbox macOS desktop descriptor", () => {
  it.each(["", "<token>", "ec2-user\nother", "../user"])(
    "rejects an unavailable or malformed inspected account %j",
    (username) => {
      expect(() => createCrabboxMacosDesktopEndpoint(leaseId, username)).toThrow(
        "inspected SSH account",
      );
      expect(() => createCrabboxMacosDesktopSetup(leaseId, "cG5n", username)).toThrow(
        "inspected SSH account",
      );
    },
  );

  it("binds ARD credentials and launchers to the inspected account and exact lease", () => {
    expect(createCrabboxMacosDesktopEndpoint(leaseId, "ec2-user")).toEqual({
      protocol: "rfb",
      port: 5900,
      allowsResize: false,
      username: "ec2-user",
      passwordFilePath: `/var/db/crabbox/openclaw-workers/${leaseId}/vnc.password`,
      apps: [
        {
          id: "browser",
          executablePath: `/var/db/crabbox/openclaw-workers/${leaseId}/browser`,
          cdpPort: 9222,
        },
        { id: "terminal", executablePath: `/var/db/crabbox/openclaw-workers/${leaseId}/terminal` },
      ],
    });
  });
});

describe.skipIf(process.platform === "win32")("Crabbox macOS desktop setup", () => {
  it.each<Readiness>(["wrong-account", "no-gui", "invalid-signature", "ad-hoc", "old-app"])(
    "rejects %s before publishing credentials or desktop launchers",
    (readiness) => {
      const fixture = desktopFixture(readiness);
      expect(fixture.result.error).toBeUndefined();
      expect(fixture.result.status, fixture.result.stderr).toBe(1);
      expect(fs.existsSync(fixture.desktop)).toBe(false);
      expect(fixture.result.stdout).not.toContain("synthetic-vnc-password");
    },
  );

  it("publishes private lease artifacts and reuses its already running browser", () => {
    const fixture = desktopFixture("ready");
    try {
      expect(fixture.result.error).toBeUndefined();
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      const passwordFile = path.join(fixture.desktop, "vnc.password");
      expect(fs.readFileSync(passwordFile, "utf8")).toBe("synthetic-vnc-password\n");
      expect(fs.statSync(passwordFile).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(fixture.desktop, "wallpaper.png"))).toEqual(wallpaper);
      const repeated = fixture.repeat();
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(fs.readFileSync(path.join(fixture.root, "launches"), "utf8")).toBe("launch\n");
      expect(fs.readFileSync(path.join(fixture.root, "browser-context"), "utf8")).toBe(
        fixture.expectedContext,
      );
      const terminal = fixture.terminal();
      expect(terminal.status, terminal.stderr).toBe(0);
      expect(fs.readFileSync(path.join(fixture.root, "terminal-context"), "utf8")).toBe(
        fixture.expectedContext,
      );
      const host = fixture.host();
      expect(host.status, host.stderr).toBe(0);
      expect(fs.readFileSync(path.join(fixture.root, "terminal-context"), "utf8")).toBe(
        fixture.expectedContext,
      );
      expect(fs.readFileSync(path.join(fixture.root, "gui-arguments"), "utf8")).toBe(
        "--cloud-worker-host\n--display-name\nWorker with spaces\n",
      );
      expect(fixture.result.stdout + fixture.result.stderr).not.toContain("synthetic-vnc-password");
    } finally {
      fixture.cleanup();
    }
  });
});
