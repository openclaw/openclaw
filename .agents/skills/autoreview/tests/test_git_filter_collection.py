"""Native Git collection boundaries using disposable filter fixtures."""
from __future__ import annotations

import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from .test_autoreview_hardening import git, init_repo, load_helper


class GitFilterCollectionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="autoreview-filter-collection.")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "operator"
        self.home.mkdir()
        self.operator_config = self.home / ".gitconfig"
        # Keep baseline reproduction safe even before the shared BT05 repair.
        # Do not use production safe_git_env as the fixture's safety oracle.
        platform_keys = (
            "PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC",
            "TEMP", "TMP", "TMPDIR", "DEVELOPER_DIR",
        )
        env = {key: os.environ[key] for key in platform_keys if key in os.environ}
        env.update({
            "HOME": str(self.home),
            "USERPROFILE": str(self.home),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_OPTIONAL_LOCKS": "0",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        })
        environment = mock.patch.dict(os.environ, env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.repo = init_repo(self.root)
        git(self.repo, "config", "core.autocrlf", "false")
        git(self.repo, "config", "commit.gpgsign", "false")
        self.helper = load_helper()
        self.clean_marker = self.root / "clean-dispatched"
        self.process_marker = self.root / "process-dispatched"
        self.cleaner = self.repo / "cleaner.py"
        self.processor = self.repo / "processor.py"
        self.data = self.repo / "data.txt"
        self.unchanged = self.repo / "unchanged.txt"
        self.attributes = self.repo / ".gitattributes"
        self.cleaner.write_text(
            "import sys\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n",
            encoding="utf-8",
        )
        self.processor.write_text(self.marker_script(self.process_marker, process=True), encoding="utf-8")
        self.attributes.write_text("data.txt filter=probe\n", encoding="utf-8")
        self.data.write_bytes(b"original\n")
        self.unchanged.write_bytes(b"unchanged\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "synthetic filter fixture")
        self.base = git(self.repo, "rev-parse", "HEAD").strip()

    @staticmethod
    def marker_script(marker: Path, *, process=False):
        ending = "raise SystemExit(23)\n" if process else "sys.stdout.buffer.write(sys.stdin.buffer.read())\n"
        return (
            "from pathlib import Path\nimport sys\n"
            f"Path({str(marker)!r}).write_text('synthetic dispatch\\n', encoding='utf-8')\n"
            + ending
        )

    @staticmethod
    def command(script: Path):
        # Git invokes filter command strings through its shell on each platform.
        return shlex.join((Path(sys.executable).as_posix(), script.as_posix()))

    def observe(self, *, exact_index=False):
        # Native collection can refresh stat caches before succeeding or failing.
        # Preserve staged entries; exact bytes are for pure preflight schedules.
        result = {
            str(path.relative_to(self.repo)): path.read_bytes()
            for path in self.repo.rglob("*") if path.is_file()
            and (exact_index or path != self.repo / ".git" / "index")
        }
        result["staged-entries"] = git(self.repo, "ls-files", "--stage", "-z")
        result["operator-config"] = (
            self.operator_config.read_bytes() if self.operator_config.exists() else None
        )
        return result

    def edit_data(self):
        self.data.write_bytes(b"edited content, different size\n")
        for path in (self.data, self.unchanged):
            info = path.stat()
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))

    def configure(self, key: str, value: str, *, source="local", append=False):
        if source == "worktree":
            git(self.repo, "config", "extensions.worktreeConfig", "true")
            prefix = ["config", "--worktree"]
        elif source in {"include", "conditional-include"}:
            included = self.repo / ".git" / "filter-include.conf"
            selector = "include.path" if source == "include" else (
                f"includeIf.gitdir:{(self.repo / '.git').resolve().as_posix()}.path"
            )
            git(self.repo, "config", selector, "filter-include.conf")
            prefix = ["config", "--file", str(included)]
        else:
            prefix = ["config", "--local"]
        git(self.repo, *prefix, *(["--add"] if append else []), key, value)

    def arm_clean(self, *, driver="probe", source="local", required="false"):
        # Configuration already exists when only the tracked script is changed.
        self.configure(f"filter.{driver}.clean", self.command(self.cleaner), source=source)
        self.configure(f"filter.{driver}.required", required, source=source)
        self.cleaner.write_text(self.marker_script(self.clean_marker), encoding="utf-8")
        self.edit_data()

    def arm_process(self, *, source="local", required="false"):
        self.configure("filter.probe.process", self.command(self.processor), source=source)
        self.configure("filter.probe.clean", self.command(self.cleaner), source=source)
        self.configure("filter.probe.required", required, source=source)
        self.cleaner.write_text(self.marker_script(self.clean_marker), encoding="utf-8")
        self.edit_data()

    def collection_calls(self):
        return (
            ("selection", lambda: self.helper["is_dirty"](self.repo)),
            ("status", lambda: self.helper["git"](
                self.repo, "status", "--porcelain", "--untracked-files=no",
            )),
            ("unstaged patch", lambda: self.helper["git"](
                self.repo, "diff", *self.helper["SAFE_DIFF_FLAGS"], "--patch",
            )),
            ("unstaged names", lambda: self.helper["git"](
                self.repo, "diff", *self.helper["SAFE_DIFF_FLAGS"], "--name-only", "-z",
            )),
            ("local bundle", lambda: self.helper["local_bundle"](self.repo)),
        )

    def assert_refused_without_dispatch(self):
        for label, call in self.collection_calls():
            with self.subTest(entrypoint=label):
                before = self.observe()
                failure = None
                result = None
                try:
                    result = call()
                except SystemExit as exc:
                    failure = exc
                # Check observable safety even when baseline returns or raises.
                self.assertFalse(self.clean_marker.exists(), "clean command executed")
                self.assertFalse(self.process_marker.exists(), "process command executed")
                self.assertEqual(self.observe(), before, "collection mutated fixture inputs")
                if label in {"unstaged patch", "local bundle"}:
                    self.assertIsNotNone(failure, "conversion-dependent content must not be accepted")
                if failure is not None:
                    self.assertRegex(str(failure), r"(?i)filter")
                elif label == "selection":
                    self.assertIs(result, True, "conversion-dependent content must not select clean")
                elif label == "status":
                    self.assertIn("data.txt", result, "status must retain the affected path")
                elif label == "unstaged names":
                    self.assertIn("data.txt", result.split("\0"), "name selection must retain the affected path")

    def assert_successful_bundle(self, paths, *patch_fragments):
        before = self.observe()
        self.assertTrue(self.helper["is_dirty"](self.repo))
        bundle = self.helper["local_bundle"](self.repo)
        self.assertEqual(bundle.paths, paths)
        for fragment in patch_fragments:
            self.assertIn(fragment, bundle.text)
        self.assertFalse(self.clean_marker.exists())
        self.assertFalse(self.process_marker.exists())
        self.assertEqual(self.observe(), before)
        return bundle

    def commit_marker_cleaner(self):
        # Preparation is native Git with no configured converter.
        self.cleaner.write_text(self.marker_script(self.clean_marker), encoding="utf-8")
        git(self.repo, "add", "cleaner.py")
        git(self.repo, "commit", "-qm", "synthetic dormant marker script")

    def refresh_known_clean_stat(self):
        # Avoid a racy index entry without sleeping or invoking a configured
        # converter: callers arm the filter only after this native refresh.
        info = self.data.stat()
        os.utime(self.data, ns=(info.st_atime_ns, info.st_mtime_ns - 2_000_000_000))
        git(self.repo, "update-index", "--refresh")

    def native_positive_control(self, marker: Path):
        failure = None
        try:
            git(self.repo, "--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--patch")
        except subprocess.CalledProcessError as exc:
            failure = exc
        # The process stub deliberately fails its handshake; dispatch is enough.
        self.assertTrue(marker.exists(), f"native Git must reach synthetic driver: {failure!r}")
        self.clean_marker.unlink(missing_ok=True)
        self.process_marker.unlink(missing_ok=True)

    def test_existing_optional_clean_driver_refuses_before_tracked_script_executes(self):
        self.arm_clean()
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.clean_marker)

    def test_existing_required_clean_driver_refuses_before_tracked_script_executes(self):
        self.arm_clean(required="true")
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.clean_marker)

    def test_optional_process_driver_and_clean_fallback_never_dispatch(self):
        self.arm_process()
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.process_marker)

    def test_required_process_driver_and_clean_fallback_never_dispatch(self):
        self.arm_process(required="true")
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.process_marker)

    def test_repository_include_is_part_of_effective_clean_configuration(self):
        self.arm_clean(source="include")
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.clean_marker)

    def test_conditional_include_is_part_of_effective_process_configuration(self):
        self.arm_process(source="conditional-include")
        self.assertEqual(git(self.repo, "config", "--includes", "--get", "filter.probe.process").strip(),
                         self.command(self.processor))
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.process_marker)

    def test_enabled_worktree_config_is_part_of_effective_clean_configuration(self):
        self.arm_clean(source="worktree")
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.clean_marker)

    def test_enabled_worktree_config_is_part_of_effective_process_configuration(self):
        self.arm_process(source="worktree")
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.process_marker)

    def test_last_empty_duplicate_disables_previous_clean_and_process_commands(self):
        self.edit_data()
        for field, script in (("clean", self.cleaner), ("process", self.processor)):
            key = f"filter.probe.{field}"
            self.configure(key, self.command(script), append=True)
            self.configure(key, "", append=True)
        before = self.observe()
        self.assertTrue(self.helper["is_dirty"](self.repo))
        self.assertEqual(self.helper["local_bundle"](self.repo).paths, {"data.txt"})
        self.assertFalse(self.clean_marker.exists())
        self.assertFalse(self.process_marker.exists())
        self.assertEqual(self.observe(), before)

    def test_last_nonempty_duplicate_overrides_earlier_empty_command(self):
        self.configure("filter.probe.clean", "", append=True)
        self.configure("filter.probe.clean", self.command(self.cleaner), append=True)
        self.cleaner.write_text(self.marker_script(self.clean_marker), encoding="utf-8")
        self.edit_data()
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.clean_marker)

    def test_last_nonempty_process_duplicate_overrides_earlier_empty_command(self):
        self.configure("filter.probe.process", "", append=True)
        self.configure("filter.probe.process", self.command(self.processor), append=True)
        self.edit_data()
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.process_marker)

    def test_worktree_empty_override_disables_effective_local_command(self):
        self.configure("filter.probe.process", self.command(self.processor))
        self.configure("filter.probe.process", "", source="worktree")
        self.edit_data()
        before = self.observe()
        self.assertEqual(self.helper["local_bundle"](self.repo).paths, {"data.txt"})
        self.assertFalse(self.process_marker.exists())
        self.assertEqual(self.observe(), before)

    def test_mixed_case_dotted_driver_name_is_not_lost_by_config_parsing(self):
        self.attributes.write_text("data.txt filter=MiXeD.Driver\n", encoding="utf-8")
        self.configure("FiLtEr.MiXeD.Driver.ClEaN", self.command(self.cleaner))
        self.cleaner.write_text(self.marker_script(self.clean_marker), encoding="utf-8")
        self.edit_data()
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.clean_marker)

    def test_equal_sign_in_driver_name_is_not_reencoded_as_command_value(self):
        self.attributes.write_text("data.txt filter=Eq=Driver\n", encoding="utf-8")
        # Key/value are separate arguments, never an interpolated -c key=value.
        self.configure("filter.Eq=Driver.clean", self.command(self.cleaner))
        self.cleaner.write_text(self.marker_script(self.clean_marker), encoding="utf-8")
        self.edit_data()
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.clean_marker)

    def test_unused_executable_driver_preserves_the_complete_local_bundle(self):
        self.commit_marker_cleaner()
        self.configure("filter.unused.clean", self.command(self.cleaner))
        self.configure("filter.unused.process", self.command(self.processor))
        self.configure("filter.unused.required", "true")
        self.edit_data()
        # No attribute selects unused, so data needs no executable conversion.
        self.assert_successful_bundle({"data.txt"}, "+edited content, different size")

    def test_missing_command_environment_support_refuses_before_collection(self):
        self.arm_clean()
        owner = self.helper["disable_git_filters"].__globals__
        original = owner["git_result"]

        def without_overlays(repo, *args, **kwargs):
            env = kwargs.get("env")
            if env and "GIT_CONFIG_COUNT" in env:
                kwargs["env"] = {key: value for key, value in env.items()
                                 if key != "GIT_CONFIG_COUNT"
                                 and not key.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"))}
            return original(repo, *args, **kwargs)

        with mock.patch.dict(owner, {"git_result": without_overlays}):
            with self.assertRaisesRegex(SystemExit, "cannot apply executable-filter protection"):
                self.helper["local_bundle"](self.repo)
        self.assertFalse(self.clean_marker.exists())
        self.assertFalse(self.process_marker.exists())

    def test_multiline_command_is_not_confused_with_a_configuration_key(self):
        self.arm_clean()
        self.configure("filter.probe.clean", self.command(self.cleaner) + "\n" + self.command(self.cleaner))
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.clean_marker)

    def test_stat_clean_filtered_neighbor_preserves_an_unrelated_edit(self):
        self.commit_marker_cleaner()
        self.refresh_known_clean_stat()
        self.configure("filter.probe.clean", self.command(self.cleaner))
        self.configure("filter.probe.process", self.command(self.processor))
        self.configure("filter.probe.required", "true")
        # Do not touch data.txt or its stat fields after the fixture refresh.
        self.unchanged.write_bytes(b"ordinary unrelated edit\n")
        bundle = self.assert_successful_bundle({"unchanged.txt"}, "+ordinary unrelated edit")
        self.assertNotIn("diff --git a/data.txt b/data.txt", bundle.text)

    def test_staged_only_filtered_path_preserves_its_committed_object_diff(self):
        self.commit_marker_cleaner()
        self.data.write_bytes(b"staged only change\n")
        git(self.repo, "add", "data.txt")
        self.refresh_known_clean_stat()
        expected_patch = git(
            self.repo, "--no-optional-locks", "diff", *self.helper["SAFE_DIFF_FLAGS"],
            "--cached", "--patch",
        )
        self.configure("filter.probe.clean", self.command(self.cleaner))
        self.configure("filter.probe.process", self.command(self.processor))
        self.configure("filter.probe.required", "true")
        bundle = self.assert_successful_bundle({"data.txt"}, expected_patch, "+staged only change")
        self.assertEqual(bundle.text.count("diff --git a/data.txt b/data.txt"), 1)

    def test_deleted_filtered_path_needs_no_converter_to_review_its_old_blob(self):
        self.commit_marker_cleaner()
        self.configure("filter.probe.clean", self.command(self.cleaner))
        self.configure("filter.probe.process", self.command(self.processor))
        self.configure("filter.probe.required", "true")
        self.data.unlink()
        self.assert_successful_bundle({"data.txt"}, "deleted file mode", "-original")

    def test_same_size_clean_filter_edit_never_becomes_a_false_clean_or_raw_patch(self):
        self.arm_clean()
        indexed = git(self.repo, "show", ":data.txt")
        self.data.write_bytes(b"modified\n")
        self.assertEqual(len(self.data.read_bytes()), len(indexed.encode("utf-8")))
        self.assertNotEqual(self.data.read_text(encoding="utf-8"), indexed)
        info = self.data.stat()
        os.utime(self.data, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.clean_marker)

    def test_same_size_process_filter_edit_never_becomes_a_false_clean_or_raw_patch(self):
        self.arm_process()
        indexed = git(self.repo, "show", ":data.txt")
        self.data.write_bytes(b"modified\n")
        self.assertEqual(len(self.data.read_bytes()), len(indexed.encode("utf-8")))
        self.assertNotEqual(self.data.read_text(encoding="utf-8"), indexed)
        info = self.data.stat()
        os.utime(self.data, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
        self.assert_refused_without_dispatch()
        self.native_positive_control(self.process_marker)

    def test_raw_different_normalized_clean_content_cannot_be_reviewed_as_passthrough(self):
        normalize = "sys.stdout.buffer.write(sys.stdin.buffer.read().lower())\n"
        self.cleaner.write_text("import sys\n" + normalize, encoding="utf-8")
        self.configure("filter.probe.clean", self.command(self.cleaner))
        self.configure("filter.probe.required", "true")
        self.data.write_bytes(b"ORIGINAL\n")
        git(self.repo, "add", "cleaner.py", "data.txt")
        git(self.repo, "commit", "-qm", "synthetic case normalization")
        self.assertEqual(git(self.repo, "show", ":data.txt"), "original\n")
        self.assertEqual(self.data.read_bytes(), b"ORIGINAL\n")
        # Keep the same conversion, but make forbidden dispatch observable.
        self.cleaner.write_text(
            "from pathlib import Path\nimport sys\n"
            f"Path({str(self.clean_marker)!r}).write_text('synthetic dispatch\\n', encoding='utf-8')\n"
            + normalize,
            encoding="utf-8",
        )
        self.unchanged.write_bytes(b"ordinary unrelated edit\n")
        info = self.data.stat()
        os.utime(self.data, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
        self.assert_refused_without_dispatch()
        # Independent native control proves raw bytes differ but normalized
        # content does not: accepting an uppercase raw patch would be wrong.
        native_patch = git(
            self.repo, "--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--patch",
        )
        self.assertTrue(self.clean_marker.exists())
        self.assertNotIn("diff --git a/data.txt b/data.txt", native_patch)
        self.assertIn("+ordinary unrelated edit", native_patch)
        self.clean_marker.unlink()

    def test_unknown_filter_attribute_without_command_still_collects_normally(self):
        self.edit_data()
        before = self.observe()
        self.assertEqual(self.helper["local_bundle"](self.repo).paths, {"data.txt"})
        self.assertEqual(self.observe(), before)

    def test_smudge_only_driver_does_not_block_read_only_collection(self):
        self.configure("filter.probe.smudge", self.command(self.processor))
        self.edit_data()
        before = self.observe()
        self.assertEqual(self.helper["local_bundle"](self.repo).paths, {"data.txt"})
        self.assertFalse(self.process_marker.exists())
        self.assertEqual(self.observe(), before)

    def test_object_only_branch_and_commit_review_remain_usable(self):
        self.data.write_bytes(b"committed change\n")
        git(self.repo, "add", "data.txt")
        git(self.repo, "commit", "-qm", "synthetic committed change")
        head = git(self.repo, "rev-parse", "HEAD").strip()
        self.arm_process(required="true")
        before = self.observe()
        for label, call in (
            ("branch", lambda: self.helper["branch_bundle"](self.repo, self.base)),
            ("commit", lambda: self.helper["commit_bundle"](self.repo, head)),
        ):
            with self.subTest(target=label):
                bundle = call()
                self.assertEqual(bundle.paths, {"data.txt"})
                self.assertIn("+committed change", bundle.text)
                self.assertNotIn("+edited content, different size", bundle.text)
                self.assertFalse(self.clean_marker.exists())
                self.assertFalse(self.process_marker.exists())
                self.assertEqual(self.observe(), before)

    def test_branch_review_keeps_merge_base_patch_when_base_has_unrelated_commits(self):
        git(self.repo, "checkout", "-qb", "base-side", self.base)
        (self.repo / "base-only.txt").write_text("unrelated base change\n", encoding="utf-8")
        git(self.repo, "add", "base-only.txt")
        git(self.repo, "commit", "-qm", "synthetic base-side change")
        base_tip = git(self.repo, "rev-parse", "HEAD").strip()
        git(self.repo, "checkout", "-qb", "candidate", self.base)
        self.data.write_bytes(b"committed candidate change\n")
        git(self.repo, "add", "data.txt")
        git(self.repo, "commit", "-qm", "synthetic candidate change")
        head = git(self.repo, "rev-parse", "HEAD").strip()
        # Capture the historical native three-dot oracle before arming filters.
        expected_patch = git(
            self.repo, "--no-optional-locks", "diff", *self.helper["SAFE_DIFF_FLAGS"],
            "--patch", "--end-of-options", f"{base_tip}...{head}",
        )
        self.assertIn("+committed candidate change", expected_patch)
        self.assertNotIn("base-only.txt", expected_patch)
        self.arm_process(required="true")
        before = self.observe()
        bundle = self.helper["branch_bundle"](self.repo, base_tip)
        self.assertEqual(bundle.paths, {"data.txt"})
        self.assertIn(expected_patch, bundle.text)
        self.assertNotIn("base-only.txt", bundle.text)
        self.assertFalse(self.clean_marker.exists())
        self.assertFalse(self.process_marker.exists())
        self.assertEqual(self.observe(), before)

    def seed_eol(self, *, global_value="true", local_value=None, attributes="*.txt text eol=crlf\n"):
        git(self.repo, "config", "--unset", "core.autocrlf")
        if local_value is not None:
            git(self.repo, "config", "core.autocrlf", local_value)
        git(self.repo, "config", "--file", str(self.operator_config), "core.autocrlf", global_value)
        os.environ["GIT_CONFIG_GLOBAL"] = str(self.operator_config)
        self.attributes.write_text(attributes, encoding="utf-8")
        self.data.write_bytes(b"original\r\n")
        self.unchanged.write_bytes(b"unchanged\r\n")
        effective = local_value if local_value is not None else global_value
        git(self.repo, "-c", f"core.autocrlf={effective}", "add", ".")
        git(self.repo, "commit", "-qm", "synthetic EOL configuration")
        for path in (self.data, self.unchanged):
            info = path.stat()
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
        return effective

    def assert_eol_selection(self, effective: str):
        before = self.observe()
        self.assertEqual(git(
            self.repo, "--no-optional-locks", "-c", f"core.autocrlf={effective}",
            "diff", "--name-only", "-z",
        ), "")
        self.assertFalse(self.helper["is_dirty"](self.repo))
        self.assertEqual(self.observe(), before)
        self.data.write_bytes(b"edited\r\n")
        before = self.observe()
        self.assertEqual(git(
            self.repo, "--no-optional-locks", "-c", f"core.autocrlf={effective}",
            "diff", "--name-only", "-z",
        ), "data.txt\0")
        self.assertEqual(self.helper["local_bundle"](self.repo).paths, {"data.txt"})
        self.assertEqual(self.observe(), before)

    def test_global_input_keeps_crlf_selection_and_real_edits(self):
        effective = self.seed_eol(global_value="input", attributes="")
        self.assert_eol_selection(effective)

    def test_attribute_eol_crlf_keeps_selection_with_local_autocrlf_false(self):
        effective = self.seed_eol(local_value="false")
        self.assert_eol_selection(effective)

    def test_attribute_eol_lf_keeps_selection_with_local_autocrlf_false(self):
        effective = self.seed_eol(local_value="false", attributes="*.txt text eol=lf\n")
        self.assert_eol_selection(effective)

    def test_minus_text_keeps_literal_crlf_change_significant(self):
        self.seed_eol(local_value="false", attributes="*.txt -text\n")
        self.assertFalse(self.helper["is_dirty"](self.repo))
        self.data.write_bytes(b"original\n")
        before = self.observe()
        self.assertEqual(self.helper["local_bundle"](self.repo).paths, {"data.txt"})
        self.assertEqual(self.observe(), before)
