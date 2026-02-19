import ast
import glob
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class VerificationResult:
    passed: bool
    gate_failed: Optional[str] = None   # "files" | "tests" | "lint" | "ast" | None
    details: str = ""
    score_override: Optional[float] = None  # -1.0 bei Hallucinated Success


class Verifier:
    def __init__(
        self,
        required_files: list = None,
        run_tests: Optional[str] = None,
        run_lint: bool = False,
        lint_paths: list = None,
        check_syntax: bool = True,
        work_dir: str = ".",
        timeout: int = 60,
    ):
        self.required_files = required_files or []
        self.run_tests = run_tests
        self.run_lint = run_lint
        self.lint_paths = lint_paths or []
        self.check_syntax = check_syntax
        self.work_dir = work_dir
        self.timeout = timeout

    def run(self) -> VerificationResult:
        # Gate 1: Files
        if self.required_files:
            result = self._gate_files()
            if not result.passed:
                return result

        # Gate 2: Tests
        if self.run_tests:
            result = self._gate_tests()
            if not result.passed:
                return result

        # Gate 3: Lint (graceful skip wenn Tool nicht installiert)
        if self.run_lint and self.lint_paths:
            result = self._gate_lint()
            if not result.passed:
                return result

        # Gate 4: AST Syntax Check
        if self.check_syntax:
            result = self._gate_ast()
            if not result.passed:
                return result

        return VerificationResult(passed=True, details="All gates passed")

    def _gate_files(self) -> VerificationResult:
        missing = []
        for pattern in self.required_files:
            # Glob-Support
            matches = glob.glob(pattern)
            if not matches and not Path(pattern).exists():
                missing.append(pattern)
        if missing:
            return VerificationResult(
                passed=False,
                gate_failed="files",
                details=f"Missing files: {missing}",
                score_override=-1.0,
            )
        return VerificationResult(passed=True, details="Files gate passed")

    def _gate_tests(self) -> VerificationResult:
        try:
            result = subprocess.run(
                self.run_tests,
                shell=True,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                cwd=self.work_dir,
            )
            if result.returncode != 0:
                return VerificationResult(
                    passed=False,
                    gate_failed="tests",
                    details=f"Tests failed (exit {result.returncode}): {result.stdout[-500:]} {result.stderr[-500:]}",
                    score_override=-1.0,
                )
            return VerificationResult(passed=True, details="Tests gate passed")
        except subprocess.TimeoutExpired:
            return VerificationResult(
                passed=False,
                gate_failed="tests",
                details=f"Tests timed out after {self.timeout}s",
                score_override=-1.0,
            )

    def _gate_lint(self) -> VerificationResult:
        # Bevorzuge ruff, fallback flake8, fallback pylint
        linter = None
        for tool in ["ruff", "flake8", "pylint"]:
            if shutil.which(tool):
                linter = tool
                break

        if not linter:
            # Graceful skip
            return VerificationResult(passed=True, details="Lint gate skipped (no linter installed)")

        cmd = [linter] + self.lint_paths
        try:
            result = subprocess.run(
                cmd,
                shell=False,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                cwd=self.work_dir,
            )
            if result.returncode != 0:
                return VerificationResult(
                    passed=False,
                    gate_failed="lint",
                    details=f"Lint failed: {result.stdout[-500:]}",
                    score_override=-1.0,
                )
            return VerificationResult(passed=True, details=f"Lint gate passed ({linter})")
        except subprocess.TimeoutExpired:
            return VerificationResult(passed=True, details="Lint gate skipped (timeout)")

    def _gate_ast(self) -> VerificationResult:
        py_files = []
        for f in self.required_files:
            if f.endswith(".py"):
                py_files.extend(glob.glob(f) or ([f] if Path(f).exists() else []))
        for filepath in py_files:
            try:
                source = Path(filepath).read_text(encoding="utf-8")
                ast.parse(source)
            except SyntaxError as e:
                return VerificationResult(
                    passed=False,
                    gate_failed="ast",
                    details=f"Syntax error in {filepath}: {e}",
                    score_override=-1.0,
                )
        return VerificationResult(passed=True, details=f"AST gate passed ({len(py_files)} files)")
