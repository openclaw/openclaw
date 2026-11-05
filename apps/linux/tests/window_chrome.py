"""Exercise desktop chrome through real X11 pointer input and window state."""

import json
import re
import subprocess
import time


class WindowChromeFixture:
    def __init__(self, artifacts_dir):
        self.artifacts_dir = artifacts_dir
        self.manager = None
        self.checks = []
        self.passed = False

    @staticmethod
    def command(*args):
        return subprocess.check_output(args, text=True, timeout=10).strip()

    @staticmethod
    def until(predicate, label):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(0.1)
        raise RuntimeError(f"Timed out waiting for {label}")

    def start(self):
        self.manager = subprocess.Popen(
            ["openbox"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.until(
            lambda: "_NET_SUPPORTING_WM_CHECK(WINDOW)" in self.command(
                "xprop", "-root", "_NET_SUPPORTING_WM_CHECK",
            ),
            "the private window manager",
        )

    def geometry(self, window):
        # xdotool double-counts frame offsets on some X11 window managers.
        info = self.command("xwininfo", "-id", window)
        return {
            key: int(re.search(label + r":\s+(-?\d+)", info).group(1))
            for key, label in (
                ("x", "Absolute upper-left X"), ("y", "Absolute upper-left Y"),
                ("width", "Width"), ("height", "Height"),
            )
        }

    def state(self, window):
        return self.command("xprop", "-id", window, "_NET_WM_STATE", "WM_STATE")

    def close_window(self, window):
        self.command("wmctrl", "-ic", window)
        # wmctrl -lp can dereference a destroyed client before the WM removes it.
        self.until(
            lambda: int(window, 16) not in {
                int(value, 16) for value in re.findall(
                    r"0x[0-9a-fA-F]+", self.command("xprop", "-root", "_NET_CLIENT_LIST"),
                )
            },
            "window manager to acknowledge closing " + window,
        )

    def record(self, name, result):
        self.checks.append({"name": name, "result": result})
        print(f"Observed native window {name}: {result}", flush=True)

    def capture(self, name):
        if self.artifacts_dir is not None:
            time.sleep(0.3)
            self.command(
                "import", "-window", "root", str(self.artifacts_dir / f"window-chrome-{name}.png"),
            )

    def drag(self, x, y, dx, dy):
        self.command("xdotool", "mousemove", str(x), str(y), "mousedown", "1")
        try:
            for step in range(1, 9):
                self.command(
                    "xdotool", "mousemove", str(x + dx * step // 8), str(y + dy * step // 8),
                )
                time.sleep(0.04)
        finally:
            self.command("xdotool", "mouseup", "1")

    def exercise(self, app, _binary, wait, Atspi):
        wait("Welcome to OpenClaw", "heading")

        def find_window():
            for line in self.command("wmctrl", "-lp").splitlines():
                parts = line.split(None, 4)
                if len(parts) == 5 and parts[2] == str(app.pid) and "OpenClaw" in parts[4]:
                    return parts[0]
            return None

        window = self.until(find_window, "the companion window")

        def click(label):
            control = wait(label, "push button")
            bounds = control.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            self.command(
                "xdotool", "mousemove", str(bounds.x + bounds.width // 2),
                str(bounds.y + bounds.height // 2), "click", "1",
            )

        def maximized():
            return "_NET_WM_STATE_MAXIMIZED_HORZ" in self.state(window)

        self.command("wmctrl", "-ir", window, "-e", "0,40,50,-1,-1")
        time.sleep(0.3)
        before = self.geometry(window)
        wait("Maximize window", "push button")
        self.capture("welcome")
        self.drag(before["x"] + 220, before["y"] + 8, 60, 40)
        after = self.until(
            lambda: self.geometry(window) if self.geometry(window)["x"] >= before["x"] + 40 else None,
            "titlebar pointer drag",
        )
        if after["y"] < before["y"] + 25:
            raise RuntimeError(f"Window did not follow the vertical drag: {before} -> {after}")
        self.record("drag", {"before": before, "after": after})

        for expected in (True, False):
            bounds = self.geometry(window)
            self.command(
                "xdotool", "mousemove", str(bounds["x"] + 400), str(bounds["y"] + 8),
                "click", "--repeat", "2", "--delay", "80", "1",
            )
            self.until(lambda: maximized() == expected, "double-click maximize or restore")
            self.record("double-click", {"maximized": expected})
            if expected:
                self.capture("maximized")

        click("Maximize window")
        self.until(maximized, "maximize button")
        click("Restore window")
        self.until(lambda: not maximized(), "restore button")
        self.record("maximize and restore buttons", True)

        before = self.geometry(window)
        self.drag(before["x"] + before["width"] - 2, before["y"] + before["height"] - 2, 40, 30)
        after = self.until(
            lambda: self.geometry(window) if self.geometry(window)["width"] >= before["width"] + 25 else None,
            "native corner resize",
        )
        if after["height"] < before["height"] + 20:
            raise RuntimeError(f"Window height did not resize: {before} -> {after}")
        self.record("resize", {"before": before, "after": after})
        self.capture("resized")

        click("Minimize window")
        self.until(lambda: "Iconic" in self.state(window), "minimize button")
        self.command("wmctrl", "-ia", window)
        self.until(lambda: "Iconic" not in self.state(window), "window restored after minimizing")
        self.record("minimize", True)
        click("Close window")
        self.until(lambda: not find_window(), "close to tray")
        self.record("close to tray", True)
        self.passed = True

    def close(self):
        if self.artifacts_dir is not None:
            (self.artifacts_dir / "window-chrome-results.json").write_text(
                json.dumps({"passed": self.passed, "checks": self.checks}, indent=2) + "\n",
            )
        if self.manager is not None:
            self.manager.terminate()
            try:
                self.manager.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.manager.kill()
                self.manager.wait(timeout=3)
