import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createCrabboxWorkerDesktopSetup } from "./crabbox-worker-desktop-setup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionBus = "unix:path=/run/fixture/bus";
const wallpaper = Buffer.from("fixture wallpaper");
type RendererState =
  | "healthy"
  | "wrong-bus"
  | "wrong-display"
  | "missing"
  | "multiple"
  | "disappeared";
type ReloadState = "healthy" | "missing" | "replaced" | "wrong-bus";

function desktopFixture(
  renderer: RendererState,
  reload: ReloadState = "healthy",
  launch = true,
  installedWallpaper: "same" | "changed" | "missing" = "same",
) {
  const root = tempDirs.make("crabbox-desktop-setup-");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const proc = path.join(root, "proc");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  if (installedWallpaper !== "missing") {
    const backgrounds = path.join(home, ".local/share/backgrounds");
    fs.mkdirSync(backgrounds, { recursive: true });
    fs.writeFileSync(
      path.join(backgrounds, "openclaw-worker.png"),
      installedWallpaper === "same" ? wallpaper : "previous wallpaper",
    );
  }
  fs.writeFileSync(path.join(root, "desktop.env"), "CRABBOX_DESKTOP_ENV=xfce\nDISPLAY=:99\n");
  fs.writeFileSync(path.join(root, "events"), "");
  const processEnvironment = (pid: number, display: string, bus: string) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(
      path.join(proc, String(pid), "environ"),
      `DISPLAY=${display}\0DBUS_SESSION_BUS_ADDRESS=${bus}\0XDG_RUNTIME_DIR=/run/fixture\0`,
    );
  };
  processEnvironment(100, ":99", sessionBus);
  if (renderer !== "missing" && renderer !== "disappeared") {
    processEnvironment(
      101,
      renderer === "wrong-display" ? ":0" : ":99",
      renderer === "wrong-bus" ? "unix:path=/run/other/bus" : sessionBus,
    );
  }
  if (renderer === "multiple") {
    processEnvironment(102, ":99", sessionBus);
  }
  const renderers = path.join(root, "renderers");
  fs.writeFileSync(
    renderers,
    renderer === "missing" ? "" : renderer === "multiple" ? "101\n102\n" : "101\n",
  );
  // OS roots and commands are fixtures; the complete generated Bash and its
  // binding/reload decisions execute unchanged, including their failure exits.
  const commands: Record<string, string> = {
    getent: 'printf "fixture:x:%s:%s::%s:/bin/bash\\n" "$(id -u)" "$(id -g)" "$FIXTURE_ROOT/home"',
    sudo: 'shift 2; exec "$@"',
    install: `args=()
while [ "$#" -gt 0 ]; do
  case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
done
/usr/bin/install "\${args[@]}"`,
    pgrep: `[ "$1 $2 $3" = "-u $(id -u) -x" ]
case "$4" in
  xfce4-session) echo 100 ;;
  xfdesktop) [ -s "$FIXTURE_ROOT/renderers" ]; cat "$FIXTURE_ROOT/renderers" ;;
  *) exit 1 ;;
esac`,
    pkill: `[ "$2 $3 $4 $5" = "-u $(id -u) -x xfdesktop" ]
printf 'kill:%s\\n' "$1" >>"$FIXTURE_ROOT/events"
: >"$FIXTURE_ROOT/renderers"`,
    nohup: `echo launch >>"$FIXTURE_ROOT/events"
exec "$@"`,
    sleep: `echo settle >>"$FIXTURE_ROOT/events"
/bin/sleep "$@"`,
    "xfconf-query": `if [ "$3" = "-l" ]; then
  echo /backdrop/screen0/monitor0/workspace0/last-image
else
  printf 'setting:%s\\n' "$4" >>"$FIXTURE_ROOT/events"
fi`,
    xrandr: "printf 'Monitors: 1\\n 0: +screen 1024/270x768/203+0+0 screen\\n'",
    xfdesktop: `if [ "\${1-}" = "--reload" ]; then
  echo reload >>"$FIXTURE_ROOT/events"
  case "$FIXTURE_RELOAD" in
    healthy) exit 0 ;;
    missing) : >"$FIXTURE_ROOT/renderers"; exit 0 ;;
  esac
  pid=201
else
  [ "$FIXTURE_LAUNCH" = true ] || exit 1
  pid=200
fi
bus="$DBUS_SESSION_BUS_ADDRESS"
[ "$FIXTURE_RELOAD" != wrong-bus ] || bus=unix:path=/run/other/bus
mkdir -p "$FIXTURE_ROOT/proc/$pid"
printf 'DISPLAY=%s\\0DBUS_SESSION_BUS_ADDRESS=%s\\0' "$DISPLAY" "$bus" >"$FIXTURE_ROOT/proc/$pid/environ"
printf '%s\\n' "$pid" >"$FIXTURE_ROOT/renderers"`,
  };
  for (const [command, body] of Object.entries(commands)) {
    fs.writeFileSync(path.join(bin, command), `#!/bin/bash\nset -euo pipefail\n${body}\n`, {
      mode: 0o700,
    });
  }
  const script = createCrabboxWorkerDesktopSetup("cbx_desktop_test", wallpaper.toString("base64"))
    .replaceAll("/var/lib/crabbox/desktop.env", path.join(root, "desktop.env"))
    .replaceAll("/proc/$process_pid/environ", `${proc}/$process_pid/environ`)
    .replaceAll("/usr/local/bin/", `${bin}/`);
  const result = spawnSync("/bin/bash", [], {
    input: script,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      FIXTURE_ROOT: root,
      FIXTURE_RELOAD: reload,
      FIXTURE_LAUNCH: String(launch),
      DISPLAY: ":0",
      DBUS_SESSION_BUS_ADDRESS: "wrong-login-session",
    },
  });
  expect(result.error).toBeUndefined();
  return {
    result,
    home,
    renderers: fs.readFileSync(renderers, "utf8").trim(),
    events: fs.readFileSync(path.join(root, "events"), "utf8").trim().split("\n"),
  };
}

describe.skipIf(process.platform !== "linux")("Crabbox desktop renderer setup", () => {
  it("retains the bound renderer without termination, launch, or settling on resumed setup", () => {
    const { result, home, renderers, events } = desktopFixture("healthy");
    expect(result.status, result.stderr).toBe(0);
    expect(renderers).toBe("101");
    expect(events.filter((event) => /^(kill:|launch$|settle$)/u.test(event))).toEqual([]);
    expect(events.at(-1)).toBe("reload");
    expect(events.some((event) => event.endsWith("/last-image"))).toBe(true);
    expect(
      fs.readFileSync(path.join(home, ".local/share/backgrounds/openclaw-worker.png")),
    ).toEqual(wallpaper);
  });

  it.each(["changed", "missing"] as const)(
    "restarts a bound renderer when the installed wallpaper is %s",
    (installedWallpaper) => {
      const { result, home, renderers, events } = desktopFixture(
        "healthy",
        "healthy",
        true,
        installedWallpaper,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(renderers).toBe("200");
      expect(events.slice(0, 2)).toEqual(["kill:-TERM", "kill:-KILL"]);
      expect(events.filter((event) => event === "launch")).toHaveLength(1);
      expect(
        fs.readFileSync(path.join(home, ".local/share/backgrounds/openclaw-worker.png")),
      ).toEqual(wallpaper);
    },
  );

  it.each<RendererState>(["wrong-bus", "wrong-display", "missing", "multiple", "disappeared"])(
    "re-homes a %s renderer before updating the wallpaper",
    (renderer) => {
      const { result, renderers, events } = desktopFixture(renderer);
      expect(result.status, result.stderr).toBe(0);
      expect(renderers).toBe("200");
      expect(events.slice(0, 2)).toEqual(["kill:-TERM", "kill:-KILL"]);
      expect(events.filter((event) => event === "launch")).toHaveLength(1);
      expect(events.indexOf("launch")).toBeLessThan(
        events.findIndex((event) => event.startsWith("setting:")),
      );
      expect(events.at(-1)).toBe("reload");
    },
  );

  it("fails before wallpaper publication when a replacement renderer cannot converge", () => {
    const { result, events } = desktopFixture("missing", "healthy", false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("renderer did not converge on the worker session");
    expect(events.some((event) => event.startsWith("setting:"))).toBe(false);
    expect(events).not.toContain("reload");
  });

  it.each<ReloadState>(["missing", "replaced", "wrong-bus"])(
    "rejects a renderer that is %s after reload",
    (reload) => {
      const { result, events } = desktopFixture("healthy", reload);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        reload === "replaced"
          ? "renderer changed during reload"
          : "renderer lost its worker session during reload",
      );
      expect(events.filter((event) => /^(kill:|launch$|settle$)/u.test(event))).toEqual([]);
      expect(events.at(-1)).toBe("reload");
    },
  );
});
