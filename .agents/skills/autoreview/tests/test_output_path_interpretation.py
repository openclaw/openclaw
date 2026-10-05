"""Output destinations are interpreted once before review and publication."""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from .test_autoreview_hardening import SCRIPT, git, init_repo, load_helper


class OutputPathInterpretationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="autoreview-output-path.")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "operator"
        self.home.mkdir()
        env = {key: os.environ[key] for key in (
            "PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "WINDIR",
            "TEMP", "TMP", "TMPDIR", "DEVELOPER_DIR",
        ) if key in os.environ}
        env.update({
            "HOME": str(self.home), "USERPROFILE": str(self.home),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0",
            "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
        })
        environment = mock.patch.dict(os.environ, env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.repo = init_repo(self.root)
        git(self.repo, "config", "core.autocrlf", "false")
        git(self.repo, "config", "commit.gpgsign", "false")
        (self.repo / "~").mkdir()
        self.names = {
            "--output": "human.txt",
            "--json-output": "report.json",
            "--status-output": "status.json",
        }
        for name in self.names.values():
            (self.repo / "~" / name).write_bytes(
                f"literal repository tilde sentinel: {name}\n".encode("utf-8")
            )
        (self.repo / "source.txt").write_bytes(b"original synthetic content\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "synthetic output-path fixture")
        (self.repo / "source.txt").write_bytes(b"changed synthetic content\n")
        self.helper = load_helper()
        self.clean_report = {
            "findings": [], "overall_correctness": "patch is correct",
            "overall_explanation": "Synthetic output-path review.",
            "overall_confidence": 0.99,
        }
        previous_cwd = Path.cwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, previous_cwd)

    def snapshot(self):
        files = {
            str(path.relative_to(self.repo)): path.read_bytes()
            for path in self.repo.rglob("*")
            if path.is_file() and path != self.repo / ".git" / "index"
        }
        # Native Git may refresh index stat data; staged entries must not change.
        return files, git(self.repo, "ls-files", "--stage", "-z")

    def invoke(self, engine, *, overrides=None, with_status=True):
        # Literal argv values model quoted shell arguments and programmatic use.
        destinations = {flag: f"~/{name}" for flag, name in self.names.items()}
        destinations.update(overrides or {})
        argv = [str(SCRIPT), "--engine", "codex", "--mode", "local", "--max-priority", "P2"]
        # Parsing order must not permit status deletion before validating a
        # later human/JSON destination.
        for flag in ("--status-output", "--output", "--json-output"):
            if flag != "--status-output" or with_status:
                argv.extend((flag, destinations[flag]))
        stdout, stderr = io.StringIO(), io.StringIO()
        main = self.helper["main_impl"]
        with mock.patch.dict(main.__globals__, {"run_engine": engine}), \
                mock.patch.object(sys, "argv", argv), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                return main()
            finally:
                self.stdout, self.stderr = stdout.getvalue(), stderr.getvalue()

    def clean_engine(self, status_path):
        def reply(_args, repo, prompt):
            self.assertEqual(repo, self.repo)
            self.assertFalse(status_path.exists(), "stale status survived pre-review cleanup")
            self.assertIn("+changed synthetic content", prompt)
            return json.dumps({**self.clean_report, "review_completion": "complete"})

        return mock.Mock(side_effect=reply)

    def assert_clean_outputs(self, directory, *, with_status=True):
        result = json.loads((directory / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(result["findings"], [])
        self.assertEqual(result["review_status"], "scoped-clean")
        self.assertNotIn("review_completion", result)
        self.assertNotIn("review_completion", result["provider_report"])
        for field in ("overall_correctness", "overall_explanation", "overall_confidence"):
            self.assertEqual(result[field], self.clean_report[field])
        if with_status:
            self.assertEqual(json.loads((directory / "status.json").read_text(encoding="utf-8")), {
                "schema_version": 1, "status": "scoped-clean", "exit_code": 0,
                "engine": "codex", "report_produced": True, "reason": None,
                "reviewer_exit_code": None, "timed_out": False,
            })
        human = (directory / "human.txt").read_text(encoding="utf-8")
        self.assertIn("scoped-clean:", human)
        self.assertIn(self.clean_report["overall_explanation"], human)
        self.assertIn(human, self.stdout)

    def test_quoted_tilde_outputs_write_only_to_expanded_destinations(self):
        status = self.home / "status.json"
        status.write_bytes(b'{"status":"scoped-clean","stale":true}\n')
        before = self.snapshot()
        engine = self.clean_engine(status)
        try:
            self.assertEqual(self.invoke(engine), 0)
        finally:
            self.assertEqual(self.snapshot(), before, "output writing changed reviewed files")
        engine.assert_called_once()
        self.assert_clean_outputs(self.home)
        self.assertEqual({path.name for path in self.home.iterdir()}, set(self.names.values()))

    def test_quoted_tilde_status_deletion_and_unavailable_write_use_one_destination(self):
        status = self.home / "status.json"
        status.write_bytes(b'{"status":"scoped-clean","stale":true}\n')
        failure = self.helper["ReviewerUnavailable"](
            "SYNTHETIC_ENGINE_UNAVAILABLE",
            result=subprocess.CompletedProcess([], 7, "", ""),
        )

        def unavailable(_args, repo, _prompt):
            self.assertEqual(repo, self.repo)
            self.assertFalse(status.exists(), "stale status survived pre-review cleanup")
            raise failure

        engine = mock.Mock(side_effect=unavailable)
        before = self.snapshot()
        try:
            with self.assertRaises(self.helper["ReviewerUnavailable"]) as caught:
                self.invoke(engine)
        finally:
            self.assertEqual(self.snapshot(), before)
        self.assertIs(caught.exception, failure)
        engine.assert_called_once()
        self.assertEqual(json.loads(status.read_text(encoding="utf-8")), {
            "schema_version": 1, "status": "reviewer_unavailable", "exit_code": 1,
            "engine": "codex", "report_produced": False, "reason": "engine_failed",
            "reviewer_exit_code": 7, "timed_out": False,
        })
        self.assertNotIn("SYNTHETIC_ENGINE_UNAVAILABLE", status.read_text(encoding="utf-8"))
        self.assertEqual({path.name for path in self.home.iterdir()}, {"status.json"})

    def test_every_destination_is_validated_before_any_status_deletion(self):
        stale = b'{"status":"scoped-clean","stale":true}\n'
        cases = (
            ("human inside repo", {"--output": "source.txt"}),
            ("JSON inside repo", {"--json-output": "source.txt"}),
            ("status inside repo", {"--status-output": "source.txt"}),
            ("expanded JSON/status alias", {"--json-output": str(self.home / "status.json")}),
            ("expanded human/status alias", {"--output": str(self.home / "status.json")}),
        )
        for label, overrides in cases:
            with self.subTest(destination=label):
                status = self.home / "status.json"
                status.write_bytes(stale)
                before = self.snapshot()
                engine = mock.Mock(side_effect=AssertionError("invalid destinations reached reviewer"))
                with self.assertRaisesRegex(SystemExit, "must point outside|must use a different path"):
                    self.invoke(engine, overrides=overrides)
                engine.assert_not_called()
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(status.read_bytes(), stale, "validation failure removed stale status")
                self.assertEqual({path.name for path in self.home.iterdir()}, {"status.json"})

    def test_report_entry_aliases_are_refused_with_and_without_status(self):
        stale = b"unrequested status must remain unchanged\n"
        status = self.home / "status.json"
        status.write_bytes(stale)
        cases = (
            ("identical", "~/report.json", "~/report.json"),
            ("expanded", "~/report.json", str(self.home / "report.json")),
            ("relative", "../operator/report.json", str(self.home / "report.json")),
            ("case", str(self.home / "report.json"), str(self.home / "REPORT.json")),
            ("unicode", str(self.home / "caf\u00e9.json"), str(self.home / "cafe\u0301.json")),
        )
        for label, human, structured in cases:
            for with_status in (False, True):
                with self.subTest(alias=label, with_status=with_status):
                    destination = Path(human).expanduser()
                    destination.write_bytes(b"existing report must remain unchanged\n")
                    outputs = {path.name: path.read_bytes() for path in self.home.iterdir()}
                    before = self.snapshot()
                    engine = mock.Mock(side_effect=AssertionError("colliding report entries reached reviewer"))
                    try:
                        with self.assertRaisesRegex(SystemExit, "must use a different path"):
                            self.invoke(engine, overrides={"--output": human, "--json-output": structured},
                                        with_status=with_status)
                    finally:
                        self.assertEqual(self.snapshot(), before)
                        self.assertEqual({path.name: path.read_bytes() for path in self.home.iterdir()}, outputs)
                        self.assertEqual(status.read_bytes(), stale)
                    engine.assert_not_called()

    def test_no_status_parent_symlink_alias_to_same_report_entry_is_refused(self):
        outputs = self.home / "reports"
        outputs.mkdir()
        alias = self.home / "reports-link"
        try:
            alias.symlink_to(outputs, target_is_directory=True)
        except OSError as error:
            if os.name == "nt" and getattr(error, "winerror", None) == 1314:
                self.skipTest("Windows symlink privilege is unavailable")
            raise
        self.assertTrue(os.path.samefile(alias, outputs))
        original_target = os.readlink(alias)
        destination = outputs / "report.json"
        original = b"existing report must remain unchanged\n"
        destination.write_bytes(original)
        inode = destination.stat().st_ino
        status = self.home / "status.json"
        stale = b"unrequested status must remain unchanged\n"
        status.write_bytes(stale)
        before = self.snapshot()
        engine = mock.Mock(side_effect=AssertionError("parent alias collision reached reviewer"))
        try:
            with self.assertRaisesRegex(SystemExit, "must use a different path"):
                self.invoke(engine, overrides={
                    "--output": str(alias / "report.json"), "--json-output": str(destination),
                }, with_status=False)
        finally:
            self.assertEqual(self.snapshot(), before)
            self.assertEqual(destination.read_bytes(), original)
            self.assertEqual(destination.stat().st_ino, inode)
            self.assertEqual(status.read_bytes(), stale)
            self.assertTrue(alias.is_symlink())
            self.assertEqual(os.readlink(alias), original_target)
        engine.assert_not_called()

    def test_distinct_report_entries_publish_without_status_even_when_hardlinked(self):
        status = self.home / "status.json"
        stale = b"unrequested status must remain unchanged\n"
        status.write_bytes(stale)
        for hardlinked in (False, True):
            with self.subTest(hardlinked=hardlinked):
                outputs = self.home / str(hardlinked)
                outputs.mkdir()
                referent = self.root / f"original-{hardlinked}.txt"
                original = b"original inode must remain unchanged\n"
                referent.write_bytes(original)
                for name in ("human.txt", "report.json"):
                    if hardlinked:
                        os.link(referent, outputs / name)
                    else:
                        (outputs / name).write_bytes(original)
                overrides = {"--output": str(outputs / "human.txt"),
                             "--json-output": str(outputs / "report.json")}
                before = self.snapshot()
                if hardlinked:
                    blocked = mock.Mock(side_effect=AssertionError("status aliases reached reviewer"))
                    with self.assertRaisesRegex(SystemExit, "must use a different path"):
                        self.invoke(blocked, overrides=overrides)
                    blocked.assert_not_called()
                    self.assertTrue(os.path.samefile(outputs / "human.txt", outputs / "report.json"))
                    self.assertEqual(status.read_bytes(), stale)
                engine = mock.Mock(return_value=json.dumps({**self.clean_report, "review_completion": "complete"}))
                try:
                    self.assertEqual(self.invoke(engine, overrides=overrides, with_status=False), 0)
                finally:
                    self.assertEqual(self.snapshot(), before)
                    self.assertEqual(referent.read_bytes(), original)
                    self.assertEqual(status.read_bytes(), stale)
                engine.assert_called_once()
                self.assert_clean_outputs(outputs, with_status=False)
                self.assertFalse(os.path.samefile(outputs / "human.txt", outputs / "report.json"))

    def test_distinct_final_symlinks_publish_without_status_without_writing_shared_referent(self):
        referent = self.root / "shared-referent.txt"
        original = b"shared referent must remain unchanged\n"
        referent.write_bytes(original)
        for name in ("human.txt", "report.json"):
            try:
                (self.home / name).symlink_to(referent)
            except OSError as error:
                if os.name == "nt" and getattr(error, "winerror", None) == 1314:
                    self.skipTest("Windows symlink privilege is unavailable")
                raise
        status = self.home / "status.json"
        stale = b"unrequested status must remain unchanged\n"
        status.write_bytes(stale)
        before = self.snapshot()
        blocked = mock.Mock(side_effect=AssertionError("status aliases reached reviewer"))
        with self.assertRaisesRegex(SystemExit, "must use a different path"):
            self.invoke(blocked)
        blocked.assert_not_called()
        for name in ("human.txt", "report.json"):
            self.assertTrue((self.home / name).is_symlink())
        self.assertEqual(referent.read_bytes(), original)
        self.assertEqual(status.read_bytes(), stale)
        engine = mock.Mock(return_value=json.dumps({**self.clean_report, "review_completion": "complete"}))
        try:
            self.assertEqual(self.invoke(engine, with_status=False), 0)
        finally:
            self.assertEqual(self.snapshot(), before)
            self.assertEqual(referent.read_bytes(), original)
            self.assertEqual(status.read_bytes(), stale)
        engine.assert_called_once()
        self.assert_clean_outputs(self.home, with_status=False)
        for name in ("human.txt", "report.json"):
            self.assertFalse((self.home / name).is_symlink())

    @unittest.skipIf(os.name == "nt", "final symlink creation requires Windows developer mode")
    def test_inside_final_symlinks_are_refused_before_any_mutation(self):
        stale = b'{"status":"scoped-clean","stale":true}\n'
        for flag, name in self.names.items():
            with self.subTest(destination=flag):
                status = self.home / "status.json"
                status.write_bytes(stale)
                target = self.root / f"keep-{name}"
                original = f"untouched external referent: {name}\n".encode("utf-8")
                target.write_bytes(original)
                destination = self.repo / name
                destination.symlink_to(target)
                self.addCleanup(destination.unlink, missing_ok=True)
                link = os.readlink(destination)
                inode = destination.lstat().st_ino
                before = self.snapshot()
                engine = mock.Mock(side_effect=AssertionError("invalid destination reached reviewer"))
                with self.assertRaisesRegex(SystemExit, f"{flag} must point outside"):
                    self.invoke(engine, overrides={flag: name})
                engine.assert_not_called()
                self.assertEqual(self.snapshot(), before)
                self.assertTrue(destination.is_symlink())
                self.assertEqual(os.readlink(destination), link)
                self.assertEqual(destination.lstat().st_ino, inode)
                self.assertEqual(target.read_bytes(), original)
                self.assertEqual(status.read_bytes(), stale, "validation failure removed stale status")

    @unittest.skipIf(os.name == "nt", "final symlink creation requires Windows developer mode")
    def test_external_final_symlinks_into_repo_are_refused_before_any_mutation(self):
        source = self.repo / "source.txt"
        for flag, name in self.names.items():
            with self.subTest(destination=flag):
                destination = self.root / name
                destination.symlink_to(source)
                status = self.home / "status.json"
                stale = b'{"status":"scoped-clean","stale":true}\n'
                status.write_bytes(stale)
                before = self.snapshot()
                engine = mock.Mock(side_effect=AssertionError("invalid destination reached reviewer"))
                with self.assertRaisesRegex(SystemExit, f"{flag} must point outside"):
                    self.invoke(engine, overrides={flag: str(destination)})
                engine.assert_not_called()
                self.assertEqual(self.snapshot(), before)
                self.assertTrue(destination.is_symlink())
                self.assertEqual(os.readlink(destination), str(source))
                self.assertEqual(status.read_bytes(), stale)

    @unittest.skipUnless(sys.platform == "darwin", "macOS firmlink alias")
    def test_inside_final_symlink_through_repository_firmlink_is_refused(self):
        alias = Path("/System/Volumes/Data") / self.repo.relative_to("/")
        if not alias.exists() or not os.path.samefile(self.repo, alias):
            self.skipTest("temporary repository has no data-volume alias")
        target = self.home / "status.json"
        stale = b'{"status":"scoped-clean","stale":true}\n'
        target.write_bytes(stale)
        destination = self.repo / "status.json"
        destination.symlink_to(target)
        engine = mock.Mock(side_effect=AssertionError("invalid destination reached reviewer"))
        before = self.snapshot()
        with self.assertRaisesRegex(SystemExit, "--status-output must point outside"):
            self.invoke(engine, overrides={"--status-output": str(alias / "status.json")})
        engine.assert_not_called()
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(destination.is_symlink())
        self.assertEqual(os.readlink(destination), str(target))
        self.assertEqual(target.read_bytes(), stale)

    def test_relative_external_destinations_keep_the_current_directory_interpretation(self):
        external = self.root / "relative-outputs"
        external.mkdir()
        status = external / "status.json"
        status.write_bytes(b'{"status":"scoped-clean","stale":true}\n')
        overrides = {flag: f"../relative-outputs/{name}" for flag, name in self.names.items()}
        before = self.snapshot()
        engine = self.clean_engine(status)
        try:
            self.assertEqual(self.invoke(engine, overrides=overrides), 0)
        finally:
            self.assertEqual(self.snapshot(), before)
        engine.assert_called_once()
        self.assert_clean_outputs(external)
        self.assertEqual({path.name for path in external.iterdir()}, set(self.names.values()))
        self.assertEqual(list(self.home.iterdir()), [])

    def test_invalid_later_destination_leaves_all_arguments_unchanged(self):
        args = argparse.Namespace(
            json_output="~/report.json", output="../operator/human.txt", status_output="source.txt",
        )
        original = vars(args).copy()
        with self.assertRaisesRegex(SystemExit, "--status-output must point outside"):
            self.helper["prepare_output_paths"](args, self.repo)
        self.assertEqual(vars(args), original)

    @unittest.skipIf(os.name == "nt", "final symlink creation requires Windows developer mode")
    def test_invalid_later_final_symlink_leaves_all_arguments_unchanged(self):
        destination = self.repo / "status.json"
        destination.symlink_to(self.home / "status.json")
        args = argparse.Namespace(
            json_output="~/report.json", output="../operator/human.txt", status_output="status.json",
        )
        original = vars(args).copy()
        with self.assertRaisesRegex(SystemExit, "--status-output must point outside"):
            self.helper["prepare_output_paths"](args, self.repo)
        self.assertEqual(vars(args), original)
        self.assertTrue(destination.is_symlink())
        self.assertEqual(os.readlink(destination), str(self.home / "status.json"))
        self.assertFalse((self.home / "status.json").exists())

    @unittest.skipIf(os.name == "nt", "directory symlink creation requires Windows developer mode")
    def test_parent_symlinks_and_following_dotdot_keep_external_entry_semantics(self):
        external = self.root / "external-outputs"
        nested = external / "nested"
        nested.mkdir(parents=True)
        parent = self.repo / "outputs"
        parent.symlink_to(nested, target_is_directory=True)
        git(self.repo, "add", "--", "outputs")
        git(self.repo, "commit", "-qm", "synthetic parent-directory symlink")
        for prefix, directory in (("outputs", nested), ("outputs/..", external)):
            with self.subTest(parent=prefix):
                status = directory / "status.json"
                status.write_bytes(b'{"status":"scoped-clean","stale":true}\n')
                overrides = {flag: f"{prefix}/{name}" for flag, name in self.names.items()}
                before = self.snapshot()
                engine = self.clean_engine(status)
                try:
                    self.assertEqual(self.invoke(engine, overrides=overrides), 0)
                finally:
                    self.assertEqual(self.snapshot(), before)
                engine.assert_called_once()
                self.assert_clean_outputs(directory)
                self.assertTrue(parent.is_symlink())
                self.assertEqual(os.readlink(parent), str(nested))
                self.assertEqual(list(self.home.iterdir()), [])

    def test_publication_keeps_prepared_paths_after_cwd_and_home_change(self):
        status = self.home / "status.json"
        status.write_bytes(b'{"status":"scoped-clean","stale":true}\n')
        shifted_cwd, shifted_home = self.root / "shifted-cwd", self.root / "shifted-home"
        shifted_cwd.mkdir()
        shifted_home.mkdir()
        clean = self.clean_engine(status)

        def reply(*args):
            result = clean(*args)
            os.chdir(shifted_cwd)
            os.environ["HOME"] = str(shifted_home)
            os.environ["USERPROFILE"] = str(shifted_home)
            return result

        before = self.snapshot()
        self.assertEqual(self.invoke(reply, overrides={"--json-output": "../operator/report.json"}), 0)
        self.assertEqual(self.snapshot(), before)
        clean.assert_called_once()
        self.assert_clean_outputs(self.home)
        self.assertEqual(list(shifted_cwd.iterdir()), [])
        self.assertEqual(list(shifted_home.iterdir()), [])

    @unittest.skipIf(os.name == "nt", "final symlink creation requires Windows developer mode")
    def test_main_replaces_final_output_symlinks_without_writing_referents(self):
        targets = {}
        for name in self.names.values():
            target = self.root / f"keep-{name}"
            original = f"untouched external referent: {name}\n".encode("utf-8")
            target.write_bytes(original)
            (self.home / name).symlink_to(target)
            targets[name] = target, original
        status = self.home / "status.json"

        def reply(_args, repo, _prompt):
            self.assertEqual(repo, self.repo)
            self.assertFalse(status.exists())
            self.assertFalse(status.is_symlink(), "status cleanup left a dangling link")
            self.assertTrue((self.home / "report.json").is_symlink())
            for target, original in targets.values():
                self.assertEqual(target.read_bytes(), original)
            return json.dumps({**self.clean_report, "review_completion": "complete"})

        engine = mock.Mock(side_effect=reply)
        before = self.snapshot()
        try:
            self.assertEqual(self.invoke(engine), 0)
        finally:
            self.assertEqual(self.snapshot(), before)
            for target, original in targets.values():
                self.assertEqual(target.read_bytes(), original, "normalized output followed its final symlink")
        engine.assert_called_once()
        self.assert_clean_outputs(self.home)
        for name in targets:
            self.assertFalse((self.home / name).is_symlink())

    @unittest.skipIf(os.name == "nt", "final symlink creation requires Windows developer mode")
    def test_status_writer_atomically_replaces_a_final_symlink(self):
        # Main removes stale status before review; exercise the actual writer
        # separately so that deletion cannot hide final-symlink semantics.
        for unavailable in (False, True):
            with self.subTest(unavailable=unavailable):
                target = self.root / f"status-referent-{unavailable}.json"
                original = b"untouched status referent\n"
                target.write_bytes(original)
                destination = self.home / f"status-{unavailable}.json"
                destination.symlink_to(target)
                args = argparse.Namespace(
                    engine="codex", status_output=str(destination), output=None, json_output=None,
                )
                self.helper["prepare_output_paths"](args, self.repo)
                failure = self.helper["ReviewerUnavailable"](
                    "SYNTHETIC_ENGINE_UNAVAILABLE", result=subprocess.CompletedProcess([], 7, "", ""),
                ) if unavailable else None
                outcome = "reviewer_unavailable" if unavailable else "scoped-clean"
                self.helper["write_review_status"](args, outcome, 1 if unavailable else 0, failure)
                self.assertFalse(destination.is_symlink())
                self.assertEqual(target.read_bytes(), original)
                saved = json.loads(destination.read_text(encoding="utf-8"))
                self.assertEqual(saved["status"], outcome)
                self.assertEqual(saved["report_produced"], not unavailable)
                self.assertEqual(saved["reviewer_exit_code"], 7 if unavailable else None)


if __name__ == "__main__":
    unittest.main()
