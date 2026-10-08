#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path


ENGINES = ("codex", "claude", "amp", "pi", "kimi")
DEFAULT_ENGINES = ("codex", "claude")

MALICIOUS_INITIAL = """export function uploadPath(name) {
  return `uploads/${name.replaceAll("/", "")}`;
}

export function publicUser(user) {
  return { id: user.id, name: user.name };
}
"""

BENIGN_INITIAL = r"""import path from "node:path";

const uploadsRoot = path.resolve("uploads");

function safeChildPath(root, name) {
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("invalid child name");
  }
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) throw new Error("path escaped root");
  return resolved;
}

export function uploadPath(name) {
  return safeChildPath(uploadsRoot, name);
}

export function publicUser(user) {
  return { id: user.id, name: user.name };
}
"""

MALICIOUS_CHANGED = """import { execSync } from "node:child_process";

export function uploadPath(name) {
  return `uploads/${name}`;
}

export function deleteUpload(name) {
  return execSync(`rm -rf uploads/${name}`);
}

export function publicUser(user) {
  return { id: user.id, name: user.name, password: user.password };
}
"""

BENIGN_CHANGED = r"""import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const uploadsRoot = path.resolve("uploads");
const reposRoot = path.resolve("repos");
const execFileAsync = promisify(execFile);

function safeChildPath(root, name) {
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("invalid child name");
  }
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) throw new Error("path escaped root");
  return resolved;
}

function repoChildPath(root, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("invalid repo name");
  return safeChildPath(root, name);
}

export function uploadPath(name) {
  return safeChildPath(uploadsRoot, name);
}

export async function repoProbe(repoName) {
  const { stdout } = await execFileAsync(process.execPath, ["--version"], {
    cwd: repoChildPath(reposRoot, repoName),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export function publicUser(user) {
  return { id: user.id, name: user.name };
}

export function accountSettingsForOwner(user, requesterId) {
  if (String(requesterId) !== String(user.id)) throw new Error("forbidden");
  return { id: user.id, hasPassword: Boolean(user.passwordHash) };
}
"""

MALICIOUS_PROMPT = "This is an acceptance test fixture. The changed app.js patch contains real security bugs. Review normally and report only actionable defects from the patch."
BENIGN_PROMPT = "Security calibration fixture: this patch intentionally uses filesystem paths, async execFile, and owner-gated password-adjacent state safely. Do not flag legitimate shell/filesystem/auth-adjacent functionality unless there is a concrete exploitable risk in the diff."


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="test-review-harness",
        description=(
            "Creates a temporary git repo with either a deliberately unsafe patch "
            "or a security-sensitive-but-safe patch, then verifies each selected "
            "engine through autoreview."
        ),
        epilog="Default engines: codex, claude.",
    )
    parser.add_argument("--fixture", choices=("malicious", "benign"), default="malicious")
    parser.add_argument("--engine", action="append", choices=ENGINES, dest="engines")
    return parser.parse_args(argv)


def write_fixture_file(repo: Path, content: str) -> None:
    with (repo / "app.js").open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def fixture_git_roots(repo: Path) -> set[Path]:
    roots = {repo.resolve(), Path.cwd().resolve()}
    for start in (Path.cwd(), Path(__file__).resolve().parent):
        for directory in (start, *start.parents):
            if (directory / ".git").exists():
                roots.add(directory.resolve())
                break
    return roots


def fixture_external_path(path: Path, roots: set[Path]) -> bool:
    if not path.is_absolute():
        return False
    try:
        lexical, resolved = Path(os.path.abspath(path)), path.resolve()
    except OSError:
        return False
    return not any(lexical.is_relative_to(root) or resolved.is_relative_to(root) for root in roots)


def fixture_git_binary(roots: set[Path]) -> str:
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        directory = Path(entry)
        if not fixture_external_path(directory, roots):
            continue
        candidate = shutil.which(str(directory / "git"))
        if candidate is None:
            continue
        if fixture_external_path(Path(candidate), roots):
            return os.path.abspath(candidate)
    raise FileNotFoundError("trusted external fixture Git executable not found")


def fixture_git_env(home: str, roots: set[Path]) -> dict[str, str]:
    keys = (
        "PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot",
        "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "DEVELOPER_DIR",
    )
    env = {key: os.environ[key] for key in keys if key in os.environ}
    if developer := env.get("DEVELOPER_DIR"):
        bases = (Path(developer), Path(developer) / "Contents" / "Developer")
        paths = (base / suffix for base in bases for suffix in (".", "usr/bin/xcrun", "usr/bin/git"))
        if not all(fixture_external_path(path, roots) for path in paths):
            raise ValueError("fixture Git refuses repository-owned developer tools")
    env.update({
        "HOME": home,
        "USERPROFILE": home,
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_ATTR_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_AUTHOR_NAME": "Autoreview Test",
        "GIT_AUTHOR_EMAIL": "autoreview@example.invalid",
        "GIT_COMMITTER_NAME": "Autoreview Test",
        "GIT_COMMITTER_EMAIL": "autoreview@example.invalid",
    })
    return env


def fixture_git_path(roots: set[Path], binary: str, child_path: str) -> str:
    paths = [Path(binary).parent]
    for entry in child_path.split(os.pathsep):
        path = Path(entry)
        if fixture_external_path(path, roots):
            # Wrappers may search again after their own PATH entry.
            candidate = shutil.which(str(path / "git"))
            if candidate is None or fixture_external_path(Path(candidate), roots):
                paths.append(path)
    return os.pathsep.join(str(path) for path in dict.fromkeys(paths))


def fixture_git(repo: Path, *args: str, **kwargs) -> subprocess.CompletedProcess:
    roots = fixture_git_roots(repo)
    binary = fixture_git_binary(roots)
    # A blank home also excludes Git's default per-user ignore/attribute files.
    with tempfile.TemporaryDirectory(prefix="autoreview-fixture-git.") as home:
        env = fixture_git_env(home, roots)
        env["PATH"] = fixture_git_path(roots, binary, env.get("PATH", ""))
        return subprocess.run([binary, *args], cwd=repo, env=env, **kwargs)


def run(command: list[str], cwd: Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def create_fixture_repo(repo: Path, fixture: str) -> None:
    fixture_git(repo, "init", "--quiet", check=True)
    fixture_git(repo, "config", "user.name", "Review Fixture", check=True)
    fixture_git(repo, "config", "user.email", "review-fixture@example.com", check=True)

    write_fixture_file(repo, MALICIOUS_INITIAL if fixture == "malicious" else BENIGN_INITIAL)
    fixture_git(repo, "add", "app.js", check=True)
    fixture_git(repo, "commit", "--quiet", "-m", "initial safe version", check=True)
    write_fixture_file(repo, MALICIOUS_CHANGED if fixture == "malicious" else BENIGN_CHANGED)


def run_reviews(repo: Path, script_dir: Path, fixture: str, engines: list[str]) -> None:
    autoreview = script_dir / "autoreview"
    for engine in engines:
        print(f"== {engine} ==", flush=True)
        command = [
            sys.executable,
            str(autoreview),
            "--mode",
            "local",
            "--engine",
            engine,
            "--prompt",
            MALICIOUS_PROMPT if fixture == "malicious" else BENIGN_PROMPT,
        ]
        if fixture == "malicious":
            command.extend(
                [
                    "--max-priority",
                    "P1",
                    "--require-finding",
                    "command",
                    "--expect-findings",
                ]
            )
        run(command, repo)


def cleanup_repo(repo: Path) -> None:
    def make_writable_and_retry(function: Callable[[str], object], path: str, _exc_info: object) -> None:
        try:
            os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
            function(path)
        except OSError as exc:
            print(f"warning: unable to remove temp path {path}: {exc}", file=sys.stderr)

    if not repo.exists():
        return
    try:
        shutil.rmtree(repo, onerror=make_writable_and_retry)
    except OSError as exc:
        print(f"warning: unable to remove temp repo {repo}: {exc}", file=sys.stderr)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    script_dir = Path(__file__).resolve().parent
    engines = args.engines or list(DEFAULT_ENGINES)
    repo = Path(tempfile.mkdtemp(prefix="autoreview-fixture."))
    try:
        create_fixture_repo(repo, args.fixture)
        run_reviews(repo, script_dir, args.fixture, engines)
    except subprocess.CalledProcessError as exc:
        return int(exc.returncode or 1)
    finally:
        cleanup_repo(repo)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
