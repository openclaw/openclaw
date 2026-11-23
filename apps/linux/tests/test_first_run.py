from contextlib import redirect_stdout
import io
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from first_run import role_matches
from gateway_switch import GatewayOnboardingFixture, GatewaySwitchFixture
from inline_browser import GatewayFixture
from stage_onboarding_runtime import stage_onboarding_runtime


class GatewayPointerTests(unittest.TestCase):
    def test_reacquires_a_replaced_accessible_before_sending_one_click(self):
        fixture = GatewaySwitchFixture.__new__(GatewaySwitchFixture)
        fixture.chrome = Mock()
        fixture.chrome.until.side_effect = lambda predicate, _label: predicate()
        fixture.windows = Mock(return_value={"1": "OpenClaw"})
        fixture.capture = Mock()
        fixture.open_native_menu = Mock()
        atspi = SimpleNamespace(
            StateType=SimpleNamespace(ACTIVE="active"),
            ScrollType=SimpleNamespace(ANYWHERE="anywhere"),
            CoordType=SimpleNamespace(SCREEN="screen"),
        )
        stale, fresh = Mock(), Mock()
        for node in (stale, fresh):
            node.get_localized_role_name.return_value = "button"
            node.get_state_set.return_value.contains.return_value = True
        stale.get_component_iface.return_value = None
        component = fresh.get_component_iface.return_value
        component.get_extents.return_value = SimpleNamespace(x=10, y=20, width=80, height=30)

        class ClickFinished(Exception):
            pass

        def wait(label, role=None, *, predicate=None):
            if label != "Add Gateway":
                return None
            if role == "heading":
                raise ClickFinished
            for node in (stale, fresh):
                if predicate(node):
                    return node
            self.fail("No clickable accessible found")

        with patch("gateway_switch.time.sleep"), self.assertRaises(ClickFinished):
            fixture.exercise(Mock(), None, wait, atspi, None)
        component.scroll_to.assert_called_once_with("anywhere")
        component.get_extents.assert_called_once_with("screen")
        pointer_calls = [call.args for call in fixture.chrome.command.call_args_list if call.args[0] == "xdotool"]
        self.assertEqual(pointer_calls, [("xdotool", "mousemove", "50", "35", "click", "1")])


class OnboardingResourcesTests(unittest.TestCase):
    def test_stages_the_compiled_runtime_without_a_parallel_installer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "source/openclaw-desktop"
            runtime = binary.parent / "desktop-runtime"
            (runtime / "bin").mkdir(parents=True)
            binary.write_bytes(b"synthetic native binary")
            (runtime / "manifest.json").write_bytes(b'{"fixture":true}\n')
            (runtime / "bin/bun").write_bytes(b"synthetic enveloped runtime")
            home = root / "home"
            prefix = home / ".openclaw"
            (prefix / "bin").mkdir(parents=True)
            with patch.dict(os.environ, {"HOME": str(home)}):
                fixture = GatewayOnboardingFixture.__new__(GatewayOnboardingFixture)
                staged = fixture.stage_binary(binary)
                self.assertEqual(staged.read_bytes(), binary.read_bytes())
                for relative in ("manifest.json", "bin/bun"):
                    self.assertEqual((staged.parent / "desktop-runtime" / relative).read_bytes(),
                                     (runtime / relative).read_bytes())
                self.assertFalse((staged.parent / "install-cli.sh").exists())

    def test_fixture_package_replaces_core_but_preserves_the_pinned_runtime(self):
        for with_package in (False, True):
            with self.subTest(with_package=with_package), tempfile.TemporaryDirectory() as temporary:
                runtime = Path(temporary) / "desktop-runtime"
                runtime.mkdir()
                copied = runtime.parent / "debug/desktop-runtime"
                copied.mkdir(parents=True)
                (copied / "stale.js").touch()
                package = runtime / "package"
                files = {"bin/bun": "runtime-hash"}
                if with_package:
                    package.mkdir()
                    (package / "old.js").write_text("old core")
                    files["package/old.js"] = "old-hash"
                (runtime / "manifest.json").write_text(json.dumps({
                    "revision": "pinned", "files": files,
                    "runtime": {"flavor": "jit", "executable": "bin/bun"},
                }))
                stage_onboarding_runtime(runtime)
                manifest = json.loads((runtime / "manifest.json").read_text())
                entry = "package/node_modules/openclaw/openclaw.mjs"
                content = (Path(__file__).parent / "fixtures/onboarding-cli.mjs").read_bytes()
                self.assertEqual(manifest, {"revision": "pinned", "files": {
                    "bin/bun": "runtime-hash", entry: hashlib.sha256(content).hexdigest(),
                }, "runtime": {"flavor": "jit", "executable": "bin/bun", "entry": entry}})
                self.assertEqual((runtime / entry).read_bytes(), b"OPENCLAW-BUN-RUNTIME-V1\n" + content)
                self.assertFalse((package / "old.js").exists())
                self.assertFalse(copied.exists())

    def test_aot_fixture_is_rejected_without_mutating_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "desktop-runtime"
            runtime.mkdir()
            original = json.dumps({"runtime": {"flavor": "aot"}, "files": {}})
            (runtime / "manifest.json").write_text(original)
            with self.assertRaisesRegex(ValueError, "requires the JIT runtime"):
                stage_onboarding_runtime(runtime)
            self.assertEqual((runtime / "manifest.json").read_text(), original)
            self.assertFalse((runtime / "package").exists())

    def test_missing_runtime_resources_fail_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "openclaw-desktop"
            binary.write_bytes(b"synthetic native binary")
            with patch.dict(os.environ, {"HOME": str(root / "home")}):
                fixture = GatewayOnboardingFixture.__new__(GatewayOnboardingFixture)
                with self.assertRaises(FileNotFoundError):
                    fixture.stage_binary(binary)


class OnboardingCliTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()
        self.launcher = self.home / ".openclaw/bin/openclaw"
        self.launcher.parent.mkdir(parents=True)
        self.launcher.write_text("#!/bin/sh\nexit 0\n")
        self.launcher.chmod(0o755)
        self.node = shutil.which("node")
        self.assertIsNotNone(self.node, "The native fixture tests require Node")

    def cli(self, *args):
        fixture = Path(__file__).parent.resolve() / "fixtures/onboarding-cli.mjs"
        return subprocess.run(
            [self.node, str(fixture), *map(str, args)], cwd=self.home,
            env={"HOME": str(self.home), "PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"},
            capture_output=True, text=True, timeout=10,
        )

    def snapshot(self):
        result = {}
        for path in [self.home, *self.home.rglob("*")]:
            info = path.lstat()
            content = os.readlink(path) if path.is_symlink() else path.read_bytes() if path.is_file() else None
            result[str(path.relative_to(self.home))] = (info.st_mode, info.st_uid, info.st_mtime_ns, content)
        return result

    def succeeds(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def rejects_without_writes(self, *args):
        before = self.snapshot()
        result = self.cli(*args)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.snapshot(), before)

    def test_terminal_setup_then_baseline_and_retry_preserve_the_profile(self):
        self.assertEqual(self.succeeds("setup", "--terminal-path", self.launcher), {"ok": True})
        config = self.home / ".openclaw/openclaw.json"
        for relative in (".openclaw/openclaw.json", "fixture-runtime-baseline.json",
                         "fixture-runtime-installed.json", "fixture-runtime-install-attempts"):
            self.assertFalse((self.home / relative).exists())
        self.assertEqual(self.launcher.read_text(), "#!/bin/sh\nexit 0\n")
        before = self.snapshot()
        status = self.succeeds("gateway", "status", "--deep", "--json", "--no-probe")
        self.assertEqual(status["service"]["runtimeIntent"]["status"], "migrationPending")
        self.assertFalse(status["service"]["loaded"])
        self.assertEqual(self.snapshot(), before)
        for args in (("setup", "--baseline"), ("setup", "--baseline", "--json", "extra")):
            with self.subTest(args=args):
                self.rejects_without_writes(*args)
        self.assertEqual(self.succeeds("setup", "--baseline", "--json"),
                         {"ok": True, "configPath": str(config)})
        self.assertEqual(json.loads(config.read_text()), {"gateway": {"mode": "local"}})
        self.assertEqual(json.loads((self.home / "fixture-runtime-baseline.json").read_text()),
                         {"configPath": str(config)})
        self.rejects_without_writes("setup", "--baseline", "--json")
        # A service-failure retry leaves a baseline but no installed runtime.
        config.write_text('{"gateway":{"mode":"local"},"retained":true}\n')
        retained = config.read_bytes()
        self.succeeds("setup", "--terminal-path", self.launcher)
        self.assertEqual(config.read_bytes(), retained)
        self.succeeds("setup", "--baseline", "--json")
        self.assertEqual(config.read_bytes(), retained)
        self.assertFalse((self.home / "fixture-runtime-installed.json").exists())

    def test_terminal_setup_rejects_wrong_arguments_before_writes(self):
        for args in (
            ("setup", "--terminal-path"),
            ("setup", "--terminal-path", self.launcher, "--json"),
            ("setup", "--terminal-path", self.home / "foreign/openclaw"),
            ("setup", "--terminal-path", self.launcher.parent / "../bin/openclaw"),
            ("setup", "--unknown-terminal-flag", self.launcher),
        ):
            with self.subTest(args=args):
                self.rejects_without_writes(*args)

    def test_terminal_setup_rejects_invalid_launcher_shapes_before_writes(self):
        for kind in ("missing", "directory", "symlink", "not-executable"):
            with self.subTest(kind=kind):
                self.launcher.unlink()
                if kind == "directory":
                    self.launcher.mkdir()
                elif kind == "symlink":
                    target = self.home / "owned-executable"
                    target.write_bytes(b"#!/bin/sh\nexit 0\n")
                    target.chmod(0o755)
                    self.launcher.symlink_to(target)
                elif kind == "not-executable":
                    self.launcher.write_text("not an executable launcher")
                self.rejects_without_writes("setup", "--terminal-path", self.launcher)
                if kind == "directory":
                    self.launcher.rmdir()
                elif self.launcher.is_symlink() or self.launcher.exists():
                    self.launcher.unlink()
                self.launcher.write_text("#!/bin/sh\nexit 0\n")
                self.launcher.chmod(0o755)

    def test_baseline_and_install_ordering_rejections_preserve_state(self):
        self.rejects_without_writes("setup", "--baseline", "--json")
        self.rejects_without_writes("gateway", "install")
        self.succeeds("setup", "--terminal-path", self.launcher)
        self.rejects_without_writes("gateway", "install")
        self.succeeds("setup", "--baseline", "--json")
        self.rejects_without_writes("gateway", "install")
        (self.home / "fixture-runtime-installed.json").write_text("{}")
        self.rejects_without_writes("setup", "--terminal-path", self.launcher)
        self.rejects_without_writes("gateway", "install")

    def test_other_commands_delegate_and_preserve_the_child_exit_status(self):
        (self.home / "fixture-cli.py").write_text(
            "import json, sys\nprint(json.dumps(sys.argv[1:]))\nsys.exit(7)\n")
        before = self.snapshot()
        result = self.cli("browser", "status", "argument with spaces")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(json.loads(result.stdout), ["browser", "status", "argument with spaces"])
        self.assertEqual(self.snapshot(), before)


class RoleMatchingTests(unittest.TestCase):
    def test_button_role_names_are_aliases(self):
        for actual in ("button", "push button"):
            for expected in ("button", "push button"):
                with self.subTest(actual=actual, expected=expected):
                    self.assertTrue(role_matches(actual, expected))
                    self.assertTrue(role_matches(actual, ("entry", expected)))

    def test_other_roles_remain_exact(self):
        for actual in ("toggle button", "radio button", "entry", "heading"):
            with self.subTest(actual=actual):
                self.assertTrue(role_matches(actual, actual))
                self.assertFalse(role_matches(actual, ("button", "push button")))
                self.assertFalse(role_matches("button", actual))
        self.assertFalse(role_matches("entry", ("heading", "toggle button")))

    def test_shifted_heading_requires_matching_html_semantics(self):
        for level in range(1, 7):
            attributes = {"computed-role": "heading", "tag": f"h{level}", "level": str(level)}
            with self.subTest(level=level):
                self.assertTrue(role_matches("document frame", "heading", attributes))
                self.assertTrue(role_matches("document frame", ("entry", "heading"), attributes))
                self.assertFalse(role_matches("document frame", "button", attributes))

    def test_shifted_entry_requires_the_observed_input_textbox_semantics(self):
        attributes = {
            "tag": "input", "id": "remote-url",
            "computed-role": "textbox", "toolkit": "WebKitGTK",
        }
        self.assertTrue(role_matches("embedded", "entry", attributes))
        self.assertTrue(role_matches("embedded", ("entry", "text"), attributes))
        self.assertFalse(role_matches("embedded", "heading", attributes))
        self.assertFalse(role_matches("embedded", "button", attributes))

    def test_non_inputs_and_incomplete_entry_semantics_are_rejected(self):
        for attributes in (
            {"tag": "button", "computed-role": "button", "id": "remote-transport-direct"},
            {"tag": "input", "computed-role": "button"},
            {"tag": "section", "computed-role": "region"},
            {"tag": "section", "computed-role": "textbox"},
            {"tag": "input"},
            {"computed-role": "textbox"},
            {},
        ):
            with self.subTest(attributes=attributes):
                self.assertFalse(role_matches("embedded", "entry", attributes))
                self.assertFalse(role_matches("toggle button", "entry", attributes))

    def test_regions_and_incomplete_heading_semantics_are_rejected(self):
        for attributes in (
            {"computed-role": "region", "tag": "section"},
            {"computed-role": "heading", "tag": "section", "level": "1"},
            {"computed-role": "heading", "tag": "h1", "level": "2"},
            {"computed-role": "heading", "tag": "h0", "level": "0"},
            {"computed-role": "heading", "tag": "h7", "level": "7"},
            {"computed-role": "heading", "tag": "h1"},
            {"tag": "h1", "level": "1"},
            {},
        ):
            with self.subTest(attributes=attributes):
                self.assertFalse(role_matches("article", "heading", attributes))


class NativeMenuTests(unittest.TestCase):
    invalid_id = "org.gtk.GDBus.UnmappedGError.Quark._LIBDBUSMENU_2dGLIB.Code0"

    def open_menu(self, rejection):
        class BusError(RuntimeError):
            pass

        calls, delivered = [], []
        current_id = 44
        click_count = 0
        error = BusError("Synthetic D-Bus rejection")
        error.remote = rejection
        app = SimpleNamespace(pid=1234, poll=lambda: None)

        def variant(signature, value):
            return SimpleNamespace(value=value, unpack=lambda: value)

        def call(service, path, interface, method, arguments, *_args):
            nonlocal current_id, click_count
            values = arguments.value if arguments else None
            calls.append((method, values))
            if method == "ListNames":
                result = ([":1.7"],)
            elif method == "GetConnectionUnixProcessID":
                result = (app.pid,)
            elif method == "Introspect":
                result = ('<node><interface name="com.canonical.dbusmenu"/></node>',)
            elif method == "AboutToShow":
                result = (False,)
            elif method == "GetLayout":
                item = (current_id, {"label": "Manage Gateways…"}, [])
                submenu = (10, {"label": "Gateways", "children-display": "submenu"}, [item])
                if values[0] == 0:
                    if values[1] == 1:
                        submenu = (submenu[0], submenu[1], [])
                    result = (1, (0, {}, [submenu]))
                else:
                    result = (1, submenu)
            elif method == "Event":
                item_id, event, _, _ = values
                if event == "clicked":
                    click_count += 1
                    if rejection and (click_count == 1 or rejection == "always-stale"):
                        current_id = 45
                        if rejection == "always-stale":
                            error.remote = self.invalid_id
                        raise error
                    delivered.append(item_id)
                result = ()
            else:
                raise AssertionError(f"Unexpected D-Bus call: {method}")
            return variant("", result)

        gio = SimpleNamespace(
            bus_get_sync=lambda *_: SimpleNamespace(call_sync=call),
            BusType=SimpleNamespace(SESSION=0),
            DBusCallFlags=SimpleNamespace(NONE=0),
            DBusError=SimpleNamespace(get_remote_error=lambda error: error.remote),
        )
        glib = SimpleNamespace(Variant=variant, Error=BusError)
        modules = {"gi": SimpleNamespace(), "gi.repository": SimpleNamespace(Gio=gio, GLib=glib)}
        self.calls, self.delivered = calls, delivered
        with patch.dict("sys.modules", modules), redirect_stdout(io.StringIO()):
            GatewayFixture.__new__(GatewayFixture).open_native_menu(app, "Manage Gateways…")

    def test_refreshes_a_rejected_menu_id_and_delivers_one_click(self):
        self.open_menu(self.invalid_id)
        self.assertEqual(self.delivered, [45])
        clicks = [values[0] for method, values in self.calls
                  if method == "Event" and values[1] == "clicked"]
        self.assertEqual(clicks, [44, 45])
        first_click = next(index for index, (method, values) in enumerate(self.calls)
                           if method == "Event" and values[1] == "clicked")
        before_click = self.calls[:first_click]
        self.assertIn(("AboutToShow", (0,)), before_click)
        self.assertIn(("AboutToShow", (10,)), before_click)
        self.assertTrue(any(method == "Event" and values[:2] == (10, "opened")
                            for method, values in before_click))

    def test_other_dbus_errors_are_not_retried(self):
        with self.assertRaisesRegex(RuntimeError, "Synthetic D-Bus rejection"):
            self.open_menu("org.freedesktop.DBus.Error.AccessDenied")
        self.assertEqual(self.delivered, [])
        self.assertEqual(sum(method == "Event" and values[1] == "clicked"
                             for method, values in self.calls), 1)

    def test_a_second_stale_id_is_not_retried_again(self):
        with self.assertRaisesRegex(RuntimeError, "Synthetic D-Bus rejection"):
            self.open_menu("always-stale")
        self.assertEqual(self.delivered, [])
        self.assertEqual(sum(method == "Event" and values[1] == "clicked"
                             for method, values in self.calls), 2)


if __name__ == "__main__":
    unittest.main()
