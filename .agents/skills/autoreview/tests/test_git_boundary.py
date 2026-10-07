from __future__ import annotations

import json
import os
import runpy
import shlex
import subprocess
import tempfile
import unittest
import sys
from pathlib import Path
from unittest import mock

from .test_autoreview_hardening import SCRIPT, git, init_repo, load_helper
from . import test_git_line_endings


ORACLE_TOOLS = runpy.run_path(str(SCRIPT.with_name("test-review-harness.py")))
IMAGE_TESTS = runpy.run_path(str(SCRIPT.with_name("autoreview_test.py")))


def write_python_fixture(path: Path, source: str) -> None:
    path.write_text(
        "#!/bin/sh\n"
        f"'''exec' {shlex.quote(sys.executable)} \"$0\" \"$@\"\n"
        "' '''\n" + source
    )
    path.chmod(0o755)


def git_wrapper_path(root: Path, original_path: str) -> str:
    directory = root / "git-wrapper"
    directory.mkdir()
    wrapper = directory / "git"
    write_python_fixture(wrapper, '''
import os, shutil, sys
from pathlib import Path
directory = Path(__file__).resolve().parent
(directory / "used").touch()
os.environ["PATH"] = os.pathsep.join(
    entry for entry in os.environ["PATH"].split(os.pathsep)
    if Path(entry).resolve() != directory
)
os.execv(shutil.which("git"), ["git", *sys.argv[1:]])
''')
    return os.pathsep.join((str(directory), original_path))


class GitFixtureIsolationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="autoreview-git-fixture.")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.harness = runpy.run_path(str(SCRIPT.with_name("test-review-harness.py")))
        roots = ORACLE_TOOLS["fixture_git_roots"](self.root)
        self.native_git = ORACLE_TOOLS["fixture_git_binary"](roots)
        # Independent routing/configuration oracle; executable lookup still
        # uses the validated boundary before any hostile fixture environment.
        self.oracle_env = {key: os.environ[key] for key in (
            "PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "WINDIR",
            "TEMP", "TMP", "TMPDIR",
        ) if key in os.environ}
        if developer := os.environ.get("DEVELOPER_DIR"):
            validated = ORACLE_TOOLS["fixture_git_env"](str(self.root), roots)
            self.oracle_env["DEVELOPER_DIR"] = validated["DEVELOPER_DIR"]
        self.oracle_env.update({
            "PATH": ORACLE_TOOLS["fixture_git_path"](roots, self.native_git, self.oracle_env.get("PATH", "")),
            "HOME": str(self.root), "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Sentinel", "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "Sentinel", "GIT_COMMITTER_EMAIL": "test@example.invalid",
        })
        self.sentinel = self.root / "sentinel"
        self.sentinel.mkdir()
        self.native(self.sentinel, "init", "-q")
        (self.sentinel / "sentinel.txt").write_text("unchanged\n")
        self.native(self.sentinel, "add", ".")
        self.native(self.sentinel, "commit", "-qm", "sentinel")
        (self.sentinel / "app.js").write_text("synthetic untracked sentinel\n")

    def native(self, repo, *args):
        return subprocess.check_output(
            [self.native_git, "-c", "maintenance.auto=false", *args], cwd=repo, env=self.oracle_env,
            stderr=subprocess.PIPE,
        ).decode("utf-8")

    def snapshot(self):
        return {str(path.relative_to(self.sentinel)): path.read_bytes()
                for path in self.sentinel.rglob("*") if path.is_file()}

    def fixture(self, owner, parent):
        if owner == "hardening":
            repo = init_repo(parent)
            (repo / "fixture.txt").write_bytes(b"fixture\n")
            git(repo, "add", ".")
            git(repo, "commit", "-qm", "fixture")
        elif owner == "image":
            case = IMAGE_TESTS["AutoreviewImageGitTests"]("runTest")
            self.addCleanup(case.doCleanups)
            case.setUp()
            repo = case.repo
        else:
            repo = parent / "repo"
            repo.mkdir()
            self.harness["create_fixture_repo"](repo, "benign")
        return repo

    def test_native_oracle_does_not_launch_background_maintenance(self):
        trace = self.root / "maintenance-trace.jsonl"
        (self.sentinel / "sentinel.txt").write_text("updated synthetic content\n")
        self.native(self.sentinel, "add", ".")
        with mock.patch.dict(self.oracle_env, {"GIT_TRACE2_EVENT": str(trace)}):
            self.native(self.sentinel, "commit", "-qm", "observe maintenance")
        events = [json.loads(line) for line in trace.read_text().splitlines()]
        children = [event["argv"] for event in events if event.get("event") == "child_start"]
        self.assertFalse(any("maintenance" in argv for argv in children), children)

    @unittest.skipIf(os.name == "nt", "POSIX executable fixtures")
    def test_custom_fixture_git_lookup_rejects_checkout_and_wrapper_tail(self):
        caller = self.root / "caller"
        caller.mkdir()
        self.native(caller, "init", "-q")
        repo_bin = caller / "bin"
        repo_bin.mkdir()
        marker = self.root / "unsafe-custom-fixture-git"
        unsafe = repo_bin / "git"
        write_python_fixture(unsafe, "from pathlib import Path\n"
                             f"Path({str(marker)!r}).touch()\nraise SystemExit(97)\n")
        git_wrapper_path(self.root, self.oracle_env["PATH"])
        wrapped = self.root / "git-wrapper"
        direct_path = os.pathsep.join((str(repo_bin), self.oracle_env["PATH"]))
        wrapper_path = os.pathsep.join((str(wrapped), direct_path))
        control = subprocess.run([str(wrapped / "git"), "--version"], env={
            **self.oracle_env, "PATH": wrapper_path,
        }, capture_output=True)
        self.assertEqual(control.returncode, 97)
        self.assertTrue(marker.exists())
        marker.unlink()
        original_cwd = Path.cwd()
        try:
            os.chdir(caller)
            for label, path in (("direct", direct_path), ("wrapped", wrapper_path)):
                for fixture_type in (test_git_line_endings.GitLineEndingTests, GitFixtureIsolationTests):
                    with self.subTest(path=label, fixture=fixture_type.__name__):
                        (wrapped / "used").unlink(missing_ok=True)
                        with mock.patch.dict(os.environ, {"PATH": path}):
                            fixture = fixture_type()
                            try:
                                fixture.setUp()
                                self.assertFalse(marker.exists())
                                if label == "wrapped":
                                    self.assertTrue((wrapped / "used").exists())
                            finally:
                                self.assertTrue(fixture.doCleanups())
        finally:
            os.chdir(original_cwd)

    def test_fixture_mutations_ignore_inherited_git_routing(self):
        dotgit = self.sentinel / ".git"
        contaminations = {
            "repository": {"GIT_DIR": str(dotgit), "GIT_WORK_TREE": str(self.sentinel),
                           "GIT_INDEX_FILE": str(dotgit / "index")},
            "directory": {"GIT_DIR": str(dotgit)},
            "worktree": {"GIT_WORK_TREE": str(self.sentinel)},
            "index": {"GIT_INDEX_FILE": str(dotgit / "index")},
            "objects": {"GIT_OBJECT_DIRECTORY": str(dotgit / "objects")},
            "config": {"GIT_CONFIG": str(dotgit / "config")},
            "common": {"GIT_COMMON_DIR": str(dotgit)},
        }
        for owner in ("hardening", "harness", "image"):
            for label, contamination in contaminations.items():
                with self.subTest(owner=owner, routing=label):
                    parent = self.root / f"{owner}-{label}"
                    parent.mkdir()
                    before = self.snapshot()
                    try:
                        with mock.patch.dict(os.environ, contamination):
                            repo = self.fixture(owner, parent)
                    finally:
                        self.assertEqual(self.snapshot(), before, "sentinel repository changed")
                    self.assertTrue((repo / ".git").is_dir())
                    self.assertEqual(self.native(repo, "rev-list", "--count", "HEAD").strip(), "1")
                    self.assertEqual(self.native(repo, "show", "-s", "--format=%ae").strip(),
                                     "autoreview@example.invalid")
                    self.assertNotIn("sentinel.txt", self.native(repo, "ls-files"))

    def test_fixture_mutations_ignore_inherited_config_and_signing(self):
        home = self.root / "home"
        home.mkdir()
        config = home / ".gitconfig"
        config.write_text("[fixture]\n inherited = true\n[commit]\n gpgsign = true\n"
                          "[gpg]\n program = unavailable-synthetic-signer\n")
        xdg = self.root / "xdg"
        (xdg / "git").mkdir(parents=True)
        (xdg / "git" / "config").write_bytes(config.read_bytes())
        variants = (
            {"HOME": str(home), "USERPROFILE": str(home), "XDG_CONFIG_HOME": str(xdg)},
            {"GIT_CONFIG_GLOBAL": str(config)},
            {"GIT_CONFIG_SYSTEM": str(config)},
            {"GIT_CONFIG_PARAMETERS": "'fixture.inherited=true' 'commit.gpgsign=true' "
                                      "'gpg.program=unavailable-synthetic-signer'"},
            {"GIT_CONFIG_COUNT": "3", "GIT_CONFIG_KEY_0": "fixture.inherited",
             "GIT_CONFIG_VALUE_0": "true", "GIT_CONFIG_KEY_1": "commit.gpgsign",
             "GIT_CONFIG_VALUE_1": "true", "GIT_CONFIG_KEY_2": "gpg.program",
             "GIT_CONFIG_VALUE_2": "unavailable-synthetic-signer"},
            {"GIT_CONFIG_COUNT": "invalid"},
        )
        before = config.read_bytes()
        for owner in ("hardening", "harness", "image"):
            for index, contamination in enumerate(variants):
                with self.subTest(owner=owner, variant=index):
                    parent = self.root / f"{owner}-{index}"
                    parent.mkdir()
                    with mock.patch.dict(os.environ, contamination):
                        repo = self.fixture(owner, parent)
                        self.assertNotIn("fixture.inherited", git(repo, "config", "--list"))
                    self.assertEqual(config.read_bytes(), before)

    def test_review_harness_preserves_caller_environment_for_review(self):
        run = self.harness["run_reviews"]
        with mock.patch("subprocess.run") as launch:
            run(self.root, SCRIPT.parent, "benign", ["codex"])
        self.assertIsNone(launch.call_args.kwargs.get("env"))
        self.assertEqual(launch.call_args.args[0][1], str(SCRIPT))

    def test_fixture_home_excludes_default_user_ignore_and_attributes(self):
        home = self.root / "operator"
        settings = home / ".config" / "git"
        settings.mkdir(parents=True)
        for kind, content in (("ignore", "app.js\n*.txt\n"),
                              ("attributes", "*.js working-tree-encoding=UTF-16\n*.txt working-tree-encoding=UTF-16\n")):
            config = settings / kind
            config.write_text(content)
            for owner in ("hardening", "harness", "image"):
                with self.subTest(owner=owner, kind=kind):
                    parent = self.root / f"home-{owner}-{kind}"
                    parent.mkdir()
                    with mock.patch.dict(os.environ, {"HOME": str(home), "USERPROFILE": str(home)}):
                        repo = self.fixture(owner, parent)
                    path, expected = {
                        "hardening": ("fixture.txt", "fixture\n"),
                        "harness": ("app.js", self.harness["BENIGN_INITIAL"]),
                        "image": ("text.txt", "old\n"),
                    }[owner]
                    self.assertEqual(self.native(repo, "show", f"HEAD:{path}"), expected)
                    self.assertEqual(config.read_text(), content)
            config.unlink()

    def test_image_fixture_is_independent_of_native_text_newlines(self):
        original = Path.write_text
        def windows_newlines(path, data, *args, **kwargs):
            if path.name == "text.txt" and data == "old\n":
                return path.write_bytes(data.replace("\n", "\r\n").encode("utf-8"))
            return original(path, data, *args, **kwargs)
        case = IMAGE_TESTS["AutoreviewImageGitTests"]("runTest")
        self.addCleanup(case.doCleanups)
        with mock.patch.object(Path, "write_text", windows_newlines):
            case.setUp()
        self.assertEqual(self.native(case.repo, "show", "HEAD:text.txt"), "old\n")

    def test_image_fixture_preserves_text_output_and_nonzero_failure(self):
        case = IMAGE_TESTS["AutoreviewImageGitTests"]("runTest")
        self.addCleanup(case.doCleanups)
        case.setUp()
        self.assertEqual(case.git("show", "HEAD:text.txt"), "old\n")
        case.commit("next.txt", b"next\n")
        self.assertEqual(case.git("show", "HEAD:next.txt"), "next\n")
        self.assertEqual(case.git("rev-list", "--count", "HEAD"), "2\n")
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            case.git("config", "--get", "fixture.absent")
        self.assertEqual(caught.exception.returncode, 1)
        self.assertEqual(caught.exception.output, "")

    def test_image_fixture_refuses_when_no_external_git_is_available(self):
        case = IMAGE_TESTS["AutoreviewImageGitTests"]("runTest")
        case.repo = self.root
        with mock.patch.dict(os.environ, {"PATH": str(self.root)}), \
                mock.patch("subprocess.run") as launch:
            with self.assertRaisesRegex(FileNotFoundError, "trusted external fixture Git"):
                case.git("init", "-q")
        launch.assert_not_called()

    @unittest.skipIf(os.name == "nt", "POSIX executable and symlink fixtures")
    def test_fixture_git_lookup_rejects_caller_checkout_and_external_symlink(self):
        caller = self.root / "caller"
        caller.mkdir()
        self.native(caller, "init", "-q")
        repo_bin = caller / "bin"
        repo_bin.mkdir()
        external = self.root / "external-bin"
        external.mkdir()
        marker = self.root / "unsafe-fixture-git"
        unsafe = repo_bin / "git"
        write_python_fixture(unsafe, "from pathlib import Path\n"
                             f"Path({str(marker)!r}).touch()\nraise SystemExit(97)\n")
        (external / "git").symlink_to(unsafe)
        wrapper_path = git_wrapper_path(self.root, self.oracle_env["PATH"])
        wrapped = self.root / "git-wrapper"
        control = subprocess.run([str(wrapped / "git"), "--version"], env={
            **self.oracle_env, "PATH": os.pathsep.join((str(external), wrapper_path)),
        }, capture_output=True)
        self.assertEqual(control.returncode, 97)
        self.assertTrue(marker.exists())
        marker.unlink()
        original_cwd = Path.cwd()
        try:
            os.chdir(caller)
            for owner in ("hardening", "harness", "image"):
                for prefix in (repo_bin, external):
                    with self.subTest(owner=owner, path=prefix.name):
                        parent = self.root / f"path-{owner}-{prefix.name}"
                        parent.mkdir()
                        (wrapped / "used").unlink(missing_ok=True)
                        with mock.patch.dict(os.environ, {
                            "PATH": os.pathsep.join((str(prefix), wrapper_path)),
                        }):
                            repo = self.fixture(owner, parent)
                        self.assertFalse(marker.exists())
                        self.assertTrue((wrapped / "used").exists())
                        self.assertEqual(self.native(repo, "rev-list", "--count", "HEAD").strip(), "1")
        finally:
            os.chdir(original_cwd)


@unittest.skipIf(os.name == "nt", "POSIX executable and symlink fixtures")
class GhGitBoundaryTests(unittest.TestCase):
    def test_nested_git_uses_trusted_executable_and_scoped_environment(self):
        with tempfile.TemporaryDirectory(prefix="autoreview-gh.") as temporary:
            root = Path(temporary).resolve()
            home = root / "home"
            home.mkdir()
            repo = init_repo(root)
            sentinel_parent = root / "other"
            sentinel_parent.mkdir()
            sentinel = init_repo(sentinel_parent)
            helper = load_helper()
            trusted = root / "trusted"
            trusted.mkdir()
            repo_bin = repo / "bin"
            repo_bin.mkdir()
            external_bin = root / "external"
            external_bin.mkdir()
            marker = root / "untrusted-git-ran"
            unsafe_git = repo_bin / "git"
            write_python_fixture(unsafe_git, "from pathlib import Path\n"
                                 f"Path({str(marker)!r}).touch()\nraise SystemExit(97)\n")
            (external_bin / "git").symlink_to(unsafe_git)
            gh = trusted / "gh"
            write_python_fixture(gh, f'''
import os, subprocess
assert os.environ["GH_TOKEN"] == "synthetic-gh-test"
assert os.environ["GH_CONFIG_DIR"] == {str(home)!r}
assert os.environ["HTTPS_PROXY"] == "http://127.0.0.1:1"
assert "UNRELATED_PROVIDER_TOKEN" not in os.environ
assert "GH_REPO" not in os.environ
assert "GIT_DIR" not in os.environ
assert "GIT_EXEC_PATH" not in os.environ
assert "GIT_CONFIG_PARAMETERS" not in os.environ
assert "GIT_CONFIG_KEY_99" not in os.environ
result = subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True)
assert result.stdout.strip() == {str(repo)!r}
print("maintenance")
''')
            env = {key: os.environ[key] for key in ("PATH", "DEVELOPER_DIR") if key in os.environ}
            env["PATH"] = git_wrapper_path(root, env["PATH"])
            env.update({
                "HOME": str(home), "GH_CONFIG_DIR": str(home),
                "GH_TOKEN": "synthetic-gh-test", "HTTPS_PROXY": "http://127.0.0.1:1",
                "UNRELATED_PROVIDER_TOKEN": "synthetic-unrelated",
                "GH_REPO": "synthetic/unrelated-repository",
                "GIT_DIR": str(sentinel / ".git"), "GIT_WORK_TREE": str(sentinel),
                "GIT_INDEX_FILE": str(sentinel / ".git" / "index"),
                "GIT_EXEC_PATH": str(repo_bin), "GIT_CONFIG_PARAMETERS": "invalid",
                "GIT_CONFIG_COUNT": "100", "GIT_CONFIG_KEY_99": "fixture.inherited",
                "GIT_CONFIG_VALUE_99": "true",
            })
            before = {str(p): p.read_bytes() for p in sentinel.rglob("*") if p.is_file()}
            for prefix in (repo_bin, external_bin):
                with self.subTest(path=prefix.name), mock.patch.dict(os.environ, {
                    **env, "PATH": os.pathsep.join((str(prefix), str(trusted), env["PATH"])),
                }, clear=True):
                    used = root / "git-wrapper" / "used"
                    used.unlink(missing_ok=True)
                    with mock.patch.object(Path, "cwd", return_value=repo):
                        self.assertTrue(helper["preflight_git"]())
                    self.assertEqual(helper["git"](repo, "rev-parse", "--show-toplevel").strip(), str(repo))
                    self.assertEqual(helper["detect_pr_base"](repo), "origin/maintenance")
                    self.assertTrue(used.exists())
                    self.assertFalse(marker.exists())
            self.assertEqual(before, {str(p): p.read_bytes() for p in sentinel.rglob("*") if p.is_file()})

    def test_unsafe_gh_configuration_requires_explicit_base(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = init_repo(root)
            helper = load_helper()
            external = root / "external-config"
            external.mkdir()
            repo_link = repo / "config-link"
            repo_link.symlink_to(external, target_is_directory=True)
            external_link = root / "repo-config-link"
            external_link.symlink_to(repo, target_is_directory=True)
            for config in (str(repo / "gh"), "relative-config", str(repo_link), str(external_link)):
                with self.subTest(config=config), mock.patch.dict(os.environ, {"GH_CONFIG_DIR": config}):
                    with self.assertRaisesRegex(SystemExit, "pass --base explicitly"):
                        helper["safe_gh_env"](repo)

    def test_differently_named_git_override_requires_explicit_base(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = init_repo(root)
            helper = load_helper()
            selected = root / "selected-git"
            # A distinct trusted executable cannot be substituted by PATH Git.
            selected.write_text("#!/bin/sh\nexit 97\n")
            selected.chmod(0o755)
            with mock.patch.dict(os.environ, {"AUTOREVIEW_GIT": str(selected)}):
                with self.assertRaisesRegex(SystemExit, "pass --base explicitly"):
                    helper["safe_gh_env"](repo)

    def test_empty_optional_environment_keeps_default_discovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = init_repo(root)
            helper = load_helper()
            with mock.patch.dict(os.environ, {
                "HOME": str(root), "GH_CONFIG_DIR": "", "XDG_CONFIG_HOME": "",
                "SSL_CERT_FILE": "", "SSL_CERT_DIR": "",
            }):
                env = helper["safe_gh_env"](repo)
                self.assertIsNotNone(env)
                self.assertNotIn("XDG_CONFIG_HOME", env)


class GhConfigPathTests(unittest.TestCase):
    def test_default_config_directory_cannot_be_the_reviewed_repository(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            home = root / "home"
            home.mkdir()
            helper = load_helper()
            env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "PATHEXT", "DEVELOPER_DIR")
                   if key in os.environ}
            cases = [(home / ".config" / "gh", {})]
            xdg = root / "xdg"
            cases.append((xdg / "gh", {"XDG_CONFIG_HOME": str(xdg)}))
            if os.name == "nt":
                appdata = root / "appdata"
                cases.append((appdata / "GitHub CLI", {"APPDATA": str(appdata)}))
            for repo, extra in cases:
                with self.subTest(config=repo.name):
                    repo.mkdir(parents=True)
                    git(repo, "init", "-q")
                    with mock.patch.dict(os.environ, {
                        **env, "HOME": str(home), "USERPROFILE": str(home), **extra,
                    }, clear=True):
                        with self.assertRaisesRegex(SystemExit, "pass --base explicitly"):
                            helper["safe_gh_env"](repo)

    @unittest.skipIf(os.name == "nt", "symlinks require Windows developer mode")
    def test_derived_config_directory_and_files_cannot_symlink_into_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = init_repo(root)
            home = root / "home"
            home.mkdir()
            xdg = root / "xdg"
            xdg.mkdir()
            helper = load_helper()
            env = {key: os.environ[key] for key in ("PATH", "DEVELOPER_DIR") if key in os.environ}
            for parent, extra in ((home / ".config", {}), (xdg, {"XDG_CONFIG_HOME": str(xdg)})):
                parent.mkdir(exist_ok=True)
                directory = parent / "gh"
                with mock.patch.dict(os.environ, {**env, "HOME": str(home), **extra}, clear=True):
                    directory.symlink_to(repo, target_is_directory=True)
                    with self.assertRaisesRegex(SystemExit, "pass --base explicitly"):
                        helper["safe_gh_env"](repo)
                    directory.unlink()
                    directory.mkdir()
                    for name in ("config.yml", "hosts.yml"):
                        link = directory / name
                        link.symlink_to(repo / name)
                        with self.assertRaisesRegex(SystemExit, "pass --base explicitly"):
                            helper["safe_gh_env"](repo)
                        link.unlink()
                    self.assertEqual(helper["safe_gh_env"](repo)["GH_CONFIG_DIR"], str(directory))


class DeveloperGitBoundaryTests(unittest.TestCase):
    def test_developer_directory_must_be_external_and_absolute(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = init_repo(root)
            helper = load_helper()
            for directory in ("Developer", str(repo / "Developer")):
                with self.subTest(directory=directory), mock.patch.dict(os.environ, {"DEVELOPER_DIR": directory}):
                    with self.assertRaisesRegex(SystemExit, "DEVELOPER_DIR"):
                        helper["safe_git_env"](repo)
            external = str(root / "ExternalDeveloper")
            with mock.patch.dict(os.environ, {"DEVELOPER_DIR": external}):
                self.assertEqual(helper["safe_git_env"](repo)["DEVELOPER_DIR"], external)

    @unittest.skipUnless(sys.platform == "darwin", "native macOS developer-tool shim")
    def test_native_git_preflight_never_dispatches_checkout_developer_tools(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = init_repo(root)
            developer = repo / "Developer"
            (developer / "usr" / "bin").mkdir(parents=True)
            marker = root / "developer-tool-dispatched"
            shim = developer / "usr" / "bin" / "xcrun"
            write_python_fixture(shim, "from pathlib import Path\n"
                                 f"Path({str(marker)!r}).touch()\nraise SystemExit(7)\n")
            env = {"PATH": "/usr/bin:/bin", "HOME": str(root),
                   "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
                   "AUTOREVIEW_GIT": "/usr/bin/git", "DEVELOPER_DIR": str(developer)}
            control = subprocess.run(["/usr/bin/git", "--version"], env=env,
                                     capture_output=True, timeout=15)
            self.assertEqual(control.returncode, 7)
            self.assertTrue(marker.exists(), "native shim must reach the synthetic developer tool")
            marker.unlink()
            alias = root / "developer-alias"
            alias.symlink_to(developer, target_is_directory=True)
            child_alias = root / "external-developer"
            (child_alias / "usr" / "bin").mkdir(parents=True)
            (child_alias / "usr" / "bin" / "xcrun").symlink_to(shim)
            app_alias = root / "ExternalXcode.app"
            (app_alias / "Contents").mkdir(parents=True)
            (app_alias / "Contents" / "Developer").symlink_to(developer, target_is_directory=True)
            for path in (developer, alias, child_alias, app_alias):
                with self.subTest(developer=path.name):
                    result = subprocess.run(
                        [sys.executable, str(SCRIPT), "--mode", "local", "--dry-run"],
                        cwd=repo, env={**env, "DEVELOPER_DIR": str(path)},
                        text=True, capture_output=True, timeout=15,
                    )
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    self.assertIn("incomplete", result.stderr)
                    self.assertIn("untrusted", result.stderr)
                    self.assertNotIn("scoped-clean", result.stdout + result.stderr)
                    self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
