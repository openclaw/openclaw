"""
Verification Gates — deterministic checks on agent output.
No LLM needed. Pure code.
"""
import os
import subprocess
import ast
from pathlib import Path
from dataclasses import dataclass, field


@dataclass
class VerificationResult:
    passed: bool = False
    checks: list[dict] = field(default_factory=list)
    summary: str = ""

    def add_check(self, name: str, passed: bool, detail: str = ""):
        self.checks.append({"name": name, "passed": passed, "detail": detail})

    def evaluate(self):
        """Set overall passed based on all checks."""
        self.passed = all(c["passed"] for c in self.checks) if self.checks else False
        failed = [c for c in self.checks if not c["passed"]]
        if failed:
            self.summary = "FAILED: " + "; ".join(c["name"] + ": " + c["detail"] for c in failed)
        else:
            self.summary = f"ALL {len(self.checks)} CHECKS PASSED"
        return self


def verify_files_exist(files: list[str], base_dir: str = ".") -> VerificationResult:
    """Gate 1: Do the required output files actually exist?"""
    result = VerificationResult()
    for f in files:
        path = Path(base_dir) / f
        exists = path.exists()
        size = path.stat().st_size if exists else 0
        result.add_check(
            f"file_exists:{f}",
            exists and size > 0,
            f"{'exists' if exists else 'MISSING'} ({size}B)" if exists else "FILE NOT FOUND"
        )
    return result.evaluate()


def verify_python_syntax(files: list[str], base_dir: str = ".") -> VerificationResult:
    """Gate 2: Does the Python code parse without syntax errors?"""
    result = VerificationResult()
    for f in files:
        if not f.endswith(".py"):
            continue
        path = Path(base_dir) / f
        if not path.exists():
            result.add_check(f"syntax:{f}", False, "file not found")
            continue
        try:
            source = path.read_text()
            ast.parse(source)
            result.add_check(f"syntax:{f}", True, "valid Python")
        except SyntaxError as e:
            result.add_check(f"syntax:{f}", False, f"SyntaxError line {e.lineno}: {e.msg}")
    return result.evaluate()


def verify_no_dangerous_imports(files: list[str], base_dir: str = ".",
                                 forbidden: list[str] = None) -> VerificationResult:
    """Gate 3: AST-based import whitelist check."""
    if forbidden is None:
        forbidden = ["subprocess", "shutil.rmtree", "os.system"]
    
    result = VerificationResult()
    for f in files:
        if not f.endswith(".py"):
            continue
        path = Path(base_dir) / f
        if not path.exists():
            continue
        try:
            tree = ast.parse(path.read_text())
            found_imports = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name in forbidden:
                            found_imports.append(alias.name)
                elif isinstance(node, ast.ImportFrom):
                    if node.module in forbidden:
                        found_imports.append(node.module)
            
            if found_imports:
                result.add_check(f"imports:{f}", False, f"forbidden: {found_imports}")
            else:
                result.add_check(f"imports:{f}", True, "clean")
        except SyntaxError:
            result.add_check(f"imports:{f}", False, "can't parse")
    return result.evaluate()


def verify_tests(test_command: str, cwd: str = ".", timeout: int = 30) -> VerificationResult:
    """Gate 4: Run tests and check they pass."""
    result = VerificationResult()
    try:
        proc = subprocess.run(
            test_command, shell=True, cwd=cwd,
            capture_output=True, text=True, timeout=timeout
        )
        passed = proc.returncode == 0
        output = (proc.stdout + proc.stderr)[-500:]  # Last 500 chars
        result.add_check("tests", passed, output.strip() if not passed else "all passed")
    except subprocess.TimeoutExpired:
        result.add_check("tests", False, f"TIMEOUT after {timeout}s")
    except Exception as e:
        result.add_check("tests", False, str(e))
    return result.evaluate()


def verify_lint(lint_command: str, cwd: str = ".", timeout: int = 15) -> VerificationResult:
    """Gate 5: Run linter and check for errors."""
    result = VerificationResult()
    try:
        proc = subprocess.run(
            lint_command, shell=True, cwd=cwd,
            capture_output=True, text=True, timeout=timeout
        )
        passed = proc.returncode == 0
        output = (proc.stdout + proc.stderr)[-300:]
        result.add_check("lint", passed, output.strip() if not passed else "clean")
    except subprocess.TimeoutExpired:
        result.add_check("lint", False, f"TIMEOUT after {timeout}s")
    except Exception as e:
        result.add_check("lint", False, str(e))
    return result.evaluate()


def run_full_verification(contract, base_dir: str = ".") -> VerificationResult:
    """Run all applicable verification gates for a contract."""
    combined = VerificationResult()
    
    # Gate 1: Files exist
    if contract.required_files:
        r = verify_files_exist(contract.required_files, base_dir)
        combined.checks.extend(r.checks)
    
    # Gate 2: Python syntax
    py_files = [f for f in contract.required_files if f.endswith(".py")]
    if py_files:
        r = verify_python_syntax(py_files, base_dir)
        combined.checks.extend(r.checks)
    
    # Gate 3: Dangerous imports
    if py_files:
        r = verify_no_dangerous_imports(py_files, base_dir)
        combined.checks.extend(r.checks)
    
    # Gate 4: Tests
    if contract.run_tests:
        r = verify_tests(contract.run_tests, base_dir)
        combined.checks.extend(r.checks)
    
    # Gate 5: Lint
    if contract.run_lint:
        r = verify_lint(contract.run_lint, base_dir)
        combined.checks.extend(r.checks)
    
    return combined.evaluate()
