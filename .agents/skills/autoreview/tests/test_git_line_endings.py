from __future__ import annotations

import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from .test_autoreview_hardening import load_helper


class GitLineEndingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="autoreview-line-endings.")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "repo"
        self.home = self.root / "operator"
        self.repo.mkdir()
        self.home.mkdir()
        self.helper = load_helper()
        self.env = self.helper["safe_git_env"](self.repo)
        self.env.update(HOME=str(self.home), GIT_CONFIG_GLOBAL=str(self.home / ".gitconfig"))
        environment = mock.patch.dict(os.environ, self.env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.git("init", "-q")

    def git(self, *args):
        return subprocess.run(
            ["git", "-c", "user.name=Line Ending Test", "-c", "user.email=test@example.invalid",
             "-c", "commit.gpgsign=false", *args],
            cwd=self.repo, env=self.env, check=True, capture_output=True,
        ).stdout

    def seed(self, *, local=None, attributes=None):
        self.git("config", "--global", "core.autocrlf", "true")
        if local is not None:
            self.git("config", "--local", "core.autocrlf", local)
        if attributes is not None:
            (self.repo / ".gitattributes").write_text(attributes, encoding="utf-8")
        for name in ("source.txt", "unchanged.txt"):
            (self.repo / name).write_bytes(b"original\r\n")
        self.git("add", ".")
        self.git("commit", "-qm", "synthetic fixture")
        for name in ("source.txt", "unchanged.txt"):
            source = self.repo / name
            info = source.stat()
            os.utime(source, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))

    def snapshot(self):
        return {str(path): path.read_bytes() for path in (
            self.repo / "source.txt", self.repo / "unchanged.txt",
            self.repo / ".git" / "index", self.home / ".gitconfig",
        )}

    def test_global_only_crlf_checkout_is_clean_without_mutation(self):
        self.seed()
        self.assertEqual(self.git("diff", "--name-only"), b"")
        before = self.snapshot()
        self.assertFalse(self.helper["is_dirty"](self.repo))
        with self.assertRaisesRegex(SystemExit, "no local changes"):
            self.helper["local_bundle"](self.repo)
        self.assertEqual(self.snapshot(), before)

    def test_explicit_home_does_not_require_a_platform_home(self):
        self.seed()
        with mock.patch("pathlib.Path.home", side_effect=RuntimeError("no platform home")):
            self.assertFalse(self.helper["is_dirty"](self.repo))

    def test_default_home_global_config_is_honored(self):
        self.seed()
        os.environ.pop("GIT_CONFIG_GLOBAL")
        self.assertFalse(self.helper["is_dirty"](self.repo))

    def test_empty_xdg_uses_the_home_global_config(self):
        self.seed()
        self.env.pop("GIT_CONFIG_GLOBAL")
        os.environ.pop("GIT_CONFIG_GLOBAL")
        self.env["XDG_CONFIG_HOME"] = os.environ["XDG_CONFIG_HOME"] = ""
        self.assertEqual(self.git("diff", "--name-only"), b"")
        self.assertFalse(self.helper["is_dirty"](self.repo))

    def test_custom_xdg_global_config_is_honored(self):
        self.seed()
        xdg = self.root / "xdg"
        (xdg / "git").mkdir(parents=True)
        (self.home / ".gitconfig").rename(xdg / "git" / "config")
        self.env.pop("GIT_CONFIG_GLOBAL")
        os.environ.pop("GIT_CONFIG_GLOBAL")
        self.env["XDG_CONFIG_HOME"] = os.environ["XDG_CONFIG_HOME"] = str(xdg)
        self.assertEqual(self.git("diff", "--name-only"), b"")
        self.assertFalse(self.helper["is_dirty"](self.repo))

    def test_real_edit_selects_only_the_edited_file(self):
        self.seed()
        (self.repo / "source.txt").write_bytes(b"edited\r\n")
        self.assertEqual(self.git("diff", "--name-only", "-z"), b"source.txt\0")
        before = self.snapshot()
        self.assertEqual(self.helper["local_bundle"](self.repo).paths, {"source.txt"})
        self.assertEqual(self.snapshot(), before)

    def test_local_override_and_attributes_keep_precedence(self):
        self.seed(local="false", attributes="*.txt -text\n")
        self.assertFalse(self.helper["is_dirty"](self.repo))
        (self.repo / "source.txt").write_bytes(b"original\n")
        self.assertEqual(self.helper["local_bundle"](self.repo).paths, {"source.txt"})

    def test_local_false_overrides_global_true_without_attributes(self):
        self.seed(local="false")
        self.assertFalse(self.helper["is_dirty"](self.repo))

    def test_global_filters_remain_disabled_for_selection(self):
        self.seed()
        marker = self.root / "filter-ran"
        attributes = self.root / "global-attributes"
        attributes.write_text("*.txt filter=probe\n", encoding="utf-8")
        program = f"import pathlib,sys;pathlib.Path({str(marker)!r}).write_text('ran');sys.stdout.buffer.write(sys.stdin.buffer.read())"
        command = [Path(sys.executable).as_posix(), "-c", program]
        self.git("config", "--global", "core.attributesFile", str(attributes))
        self.git("config", "--global", "filter.probe.clean", shlex.join(command))
        self.git("config", "--global", "filter.probe.required", "true")
        (self.repo / "source.txt").write_bytes(b"edited\r\n")
        self.assertEqual(self.helper["local_bundle"](self.repo).paths, {"source.txt"})
        self.assertFalse(marker.exists())
        self.git("diff", "--name-only")
        self.assertTrue(marker.exists(), "native Git must exercise the filter positive control")

    def test_repository_owned_global_override_is_not_imported(self):
        self.seed()
        override = self.repo / ".git" / "global-config"
        override.write_text("[core]\n    autocrlf = true\n", encoding="utf-8")
        os.environ["GIT_CONFIG_GLOBAL"] = str(override)
        self.assertTrue(self.helper["is_dirty"](self.repo))
