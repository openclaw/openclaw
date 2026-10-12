import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from first_run import role_matches
from gateway_switch import GatewayOnboardingFixture


class OnboardingResourcesTests(unittest.TestCase):
    def test_stages_runtime_and_installs_a_canonical_launcher(self):
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
                subprocess.run([
                    "bash", str(staged.parent / "install-cli.sh"), "--json", "--no-onboard",
                    "--prefix", str(prefix), "--version", "main", "--runtime-only",
                    "--install-method", "git", "--git-dir", str(prefix / "dev/openclaw"),
                ], cwd=home, check=True, capture_output=True)
                cli = prefix / "bin/openclaw"
                self.assertEqual(cli.read_text(), '#!/usr/bin/env bash\nset -euo pipefail\n'
                                 f'exec "{prefix}/tools/node/bin/node" "{prefix}/dev/openclaw/dist/entry.js" "$@"\n')
                self.assertIn("OpenClaw fixture", subprocess.check_output([str(cli), "--version"], text=True))
                self.assertTrue((home / "fixture-installer-called").is_file())
                self.assertFalse((home / "fixture-runtime-installed.json").exists())

    def test_missing_runtime_resources_fail_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "openclaw-desktop"
            binary.write_bytes(b"synthetic native binary")
            with patch.dict(os.environ, {"HOME": str(root / "home")}):
                fixture = GatewayOnboardingFixture.__new__(GatewayOnboardingFixture)
                with self.assertRaises(FileNotFoundError):
                    fixture.stage_binary(binary)


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


if __name__ == "__main__":
    unittest.main()
