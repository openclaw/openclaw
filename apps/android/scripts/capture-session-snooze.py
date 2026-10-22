#!/usr/bin/env python3
"""Capture synthetic snooze states on the emulator owned by android-screenshots.sh."""

import pathlib
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


adb, serial, phase, destination = sys.argv[1:]
output = pathlib.Path(destination)
package = "ai.openclaw.app.debug"


def run(*args):
    return subprocess.check_output([adb, "-s", serial, *args])


def tree():
    raw = run("exec-out", "uiautomator", "dump", "/dev/tty").decode()
    (output / "last-ui-dump.txt").write_text(raw)
    # During Activity startup UIAutomator can succeed before a root is available.
    if "<?xml" not in raw or "</hierarchy>" not in raw:
        return None, raw
    xml = raw[raw.index("<?xml"):raw.rindex("</hierarchy>") + len("</hierarchy>")]
    return ET.fromstring(xml), xml


def find(root, label):
    return next((node for node in root.iter("node") if label in (node.get("text"), node.get("content-desc"))), None)


def wait_for(label):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        root, xml = tree()
        node = find(root, label) if root is not None else None
        if node is not None:
            return root, xml, node
        time.sleep(0.5)
    raise RuntimeError(f"Timed out waiting for {label!r}")


def tap(label, long=False):
    _, _, node = wait_for(label)
    left, top, right, bottom = map(int, re.findall(r"\d+", node.get("bounds")))
    x, y = str((left + right) // 2), str((top + bottom) // 2)
    if long:
        run("shell", "input", "swipe", x, y, x, y, "800")
    else:
        run("shell", "input", "tap", x, y)


def capture(name, required=(), absent=()):
    for label in required:
        wait_for(label)
    root, xml = tree()
    if root is None:
        raise RuntimeError(f"{name}: UIAutomator did not return a complete UI tree")
    for label in absent:
        if find(root, label) is not None:
            raise AssertionError(f"{name}: unexpected {label!r}")
    (output / f"{name}.xml").write_text(xml)
    (output / f"{name}.png").write_bytes(run("exec-out", "screencap", "-p"))
    print(f"Captured {output / (name + '.png')}", flush=True)


run("shell", "am", "force-stop", package)
run("shell", "am", "start", "-W", "-n", f"{package}/ai.openclaw.app.MainActivity",
    "--ez", "openclaw.screenshotMode", "true", "--es", "openclaw.screenshotScene", "snooze")
tap("Show Sidebar")
tap("Threads")
wait_for("Recent")
if phase == "before":
    capture("threads-recent", required=("Trip checklist", "Weekend reading"), absent=("Snoozed",))
    capture("threads-no-snoozed-pill", required=("Recent", "Current"), absent=("Snoozed",))
else:
    capture("threads-recent", required=("Trip checklist",), absent=("Weekend reading",))
tap("Trip checklist", long=True)
capture("active-row-menu", required=("Pin",) + (("Snooze",) if phase == "after" else ()),
        absent=("Snooze",) if phase == "before" else ())
run("shell", "input", "keyevent", "4")
if phase == "after":
    tap("Snoozed")
    root, _, _ = wait_for("Weekend reading")
    if not any((node.get("text") or "").startswith("Wakes ") for node in root.iter("node")):
        raise AssertionError("Snoozed row does not show its wake time")
    capture("threads-snoozed", required=("Weekend reading",), absent=("Trip checklist",))
tap("Weekend reading", long=True)
root, _, _ = wait_for("Pin")
has_wake = any((node.get("text") or "").startswith("Wake session · ") for node in root.iter("node"))
if has_wake != (phase == "after"):
    raise AssertionError("Wake session menu state does not match capture phase")
capture("snoozed-row-menu", required=("Pin",), absent=("Snooze",))
