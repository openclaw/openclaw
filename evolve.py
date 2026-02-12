"""
O.R.I.O.N. EVOLUTION ENGINE - THE UPDATE MANAGER
=================================================
Main orchestrator for safe self-improvement through the kernel/plugin architecture.

This module coordinates the entire update workflow:
1. Download new code to sandbox
2. Security verification via Kernel Guard
3. Personalization via LLM (Code Critic)
4. Installation to modules/ directory

Philosophy: The Core (Identity) is immutable. Skills (Modules) evolve.
"""

import os
import sys
import shutil
import tempfile
import subprocess
import json
from typing import List, Dict, Any, Optional
from pathlib import Path
import requests

# Import core modules (immutable dependencies)
from core.kernel_guard import verify_integrity, KernelGuard
from core.memory import remember


class EvolutionEngine:
    """
    The Update Manager - Safely evolves O.R.I.O.N.'s capabilities
    while protecting the immutable Core Identity.
    """

    def __init__(self, ollama_host: str = "http://localhost:11434"):
        """
        Initialize the Evolution Engine.

        Args:
            ollama_host: URL of Ollama server for code personalization
        """
        self.ollama_host = ollama_host
        self.model = "llama3"
        self.sandbox_dir = None
        self.kernel_guard = KernelGuard()

        print("🧬 Evolution Engine initialized")
        print(f"   Ollama: {ollama_host}")
        print(f"   LLM Model: {self.model}")

    def _check_ollama(self) -> bool:
        """Check if Ollama is running."""
        try:
            response = requests.get(f"{self.ollama_host}/api/tags", timeout=5)
            return response.status_code == 200
        except:
            return False

    def _create_sandbox(self) -> str:
        """
        Create a temporary sandbox directory for downloads.

        Returns:
            Path to sandbox directory
        """
        sandbox = tempfile.mkdtemp(prefix="orion_sandbox_")
        self.sandbox_dir = sandbox
        print(f"📦 Sandbox created: {sandbox}")
        return sandbox

    def _cleanup_sandbox(self) -> None:
        """Remove the sandbox directory."""
        if self.sandbox_dir and os.path.exists(self.sandbox_dir):
            shutil.rmtree(self.sandbox_dir)
            print(f"🧹 Sandbox cleaned: {self.sandbox_dir}")
            self.sandbox_dir = None

    def download_repository(self, repo_url: str, target_dir: str) -> bool:
        """
        Clone a Git repository to the target directory.

        Args:
            repo_url: GitHub repository URL (or zipball URL)
            target_dir: Where to download the repository

        Returns:
            True if successful, False otherwise
        """
        print(f"\n📥 Downloading repository...")
        print(f"   Source: {repo_url}")
        print(f"   Target: {target_dir}")

        try:
            # Check if it's a zipball URL
            if 'zipball' in repo_url or repo_url.endswith('.zip'):
                return self._download_zipball(repo_url, target_dir)
            else:
                # Assume it's a git URL
                return self._clone_git_repo(repo_url, target_dir)
        except Exception as e:
            print(f"❌ Download failed: {e}")
            return False

    def _download_zipball(self, url: str, target_dir: str) -> bool:
        """Download and extract a zipball."""
        import zipfile
        import io

        try:
            response = requests.get(url, timeout=30, stream=True)
            if response.status_code != 200:
                print(f"❌ HTTP {response.status_code}")
                return False

            # Extract the zip file
            with zipfile.ZipFile(io.BytesIO(response.content)) as zip_ref:
                zip_ref.extractall(target_dir)

            print("✅ Download and extraction complete")
            return True
        except Exception as e:
            print(f"❌ Zipball download failed: {e}")
            return False

    def _clone_git_repo(self, repo_url: str, target_dir: str) -> bool:
        """Clone a repository using git."""
        try:
            result = subprocess.run(
                ['git', 'clone', repo_url, target_dir],
                capture_output=True,
                text=True,
                timeout=60
            )

            if result.returncode == 0:
                print("✅ Repository cloned successfully")
                return True
            else:
                print(f"❌ Git clone failed: {result.stderr}")
                return False
        except subprocess.TimeoutExpired:
            print("❌ Git clone timed out")
            return False
        except FileNotFoundError:
            print("❌ Git not found - please install git")
            return False
        except Exception as e:
            print(f"❌ Git clone error: {e}")
            return False

    def _get_python_files(self, directory: str) -> List[str]:
        """
        Get all Python files in a directory recursively.

        Args:
            directory: Root directory to search

        Returns:
            List of relative file paths
        """
        python_files = []
        for root, dirs, files in os.walk(directory):
            # Skip hidden directories and common non-code dirs
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['__pycache__', 'tests', 'docs']]

            for file in files:
                if file.endswith('.py'):
                    full_path = os.path.join(root, file)
                    rel_path = os.path.relpath(full_path, directory)
                    python_files.append(rel_path)

        return python_files

    def _personalize_code(self, code: str, filename: str) -> Optional[str]:
        """
        Use LLM to rewrite code to match O.R.I.O.N.'s style and safety standards.

        Args:
            code: Original code to personalize
            filename: Name of the file (for context)

        Returns:
            Personalized code, or None if LLM unavailable
        """
        if not self._check_ollama():
            print("⚠️ Ollama unavailable - skipping personalization")
            return None

        prompt = f"""You are the Code Critic for O.R.I.O.N., an AI system with strict safety standards.

Your task: Rewrite this Python code to match O.R.I.O.N.'s coding standards:

STANDARDS:
- Add comprehensive docstrings (Google style)
- Include safety checks and error handling
- Add type hints
- Follow PEP 8 style guide
- Add comments explaining security-sensitive operations
- Ensure no hardcoded credentials or unsafe file operations
- Prefix print statements with emoji status indicators (✅ ❌ ⚠️ 🔒 etc.)

IMPORTANT:
- Do NOT blindly copy. Think about security and reliability.
- Keep the core functionality but improve code quality.
- If you see security issues, fix them.

File: {filename}

Original Code:
{code}

Personalized Code (reply with ONLY the code, no explanations):"""

        try:
            response = requests.post(
                f"{self.ollama_host}/api/generate",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False
                },
                timeout=120  # Longer timeout for code generation
            )

            if response.status_code == 200:
                result = response.json()
                personalized_code = result.get("response", "")

                # Clean up the response (remove markdown code blocks if present)
                if "```python" in personalized_code:
                    personalized_code = personalized_code.split("```python")[1]
                    personalized_code = personalized_code.split("```")[0]
                elif "```" in personalized_code:
                    personalized_code = personalized_code.split("```")[1]
                    personalized_code = personalized_code.split("```")[0]

                return personalized_code.strip()
            else:
                print(f"❌ LLM request failed: {response.status_code}")
                return None
        except Exception as e:
            print(f"❌ Personalization error: {e}")
            return None

    def security_check(self, file_list: List[str]) -> bool:
        """
        Run security verification via Kernel Guard.

        Args:
            file_list: List of file paths to check

        Returns:
            True if safe, False if protected paths detected
        """
        return self.kernel_guard.verify_integrity(file_list, verbose=True)

    def personalize_files(self, sandbox_dir: str) -> Dict[str, int]:
        """
        Personalize all Python files in the sandbox using the Code Critic.

        Args:
            sandbox_dir: Directory containing downloaded files

        Returns:
            Dict with stats: {personalized, skipped, failed}
        """
        print("\n" + "=" * 60)
        print("🎨 CODE CRITIC - PERSONALIZATION PHASE")
        print("=" * 60)

        python_files = self._get_python_files(sandbox_dir)
        print(f"Found {len(python_files)} Python file(s) to personalize")

        stats = {"personalized": 0, "skipped": 0, "failed": 0}

        for rel_path in python_files:
            full_path = os.path.join(sandbox_dir, rel_path)

            print(f"\n📝 Processing: {rel_path}")

            try:
                # Read original code
                with open(full_path, 'r', encoding='utf-8') as f:
                    original_code = f.read()

                # Personalize with LLM
                personalized_code = self._personalize_code(original_code, rel_path)

                if personalized_code:
                    # Write personalized version
                    with open(full_path, 'w', encoding='utf-8') as f:
                        f.write(personalized_code)
                    print(f"   ✅ Personalized ({len(personalized_code)} chars)")
                    stats["personalized"] += 1
                else:
                    print(f"   ⚠️ Skipped (LLM unavailable)")
                    stats["skipped"] += 1

            except Exception as e:
                print(f"   ❌ Failed: {e}")
                stats["failed"] += 1

        print("\n" + "=" * 60)
        print(f"Personalization complete:")
        print(f"  ✅ Personalized: {stats['personalized']}")
        print(f"  ⚠️ Skipped: {stats['skipped']}")
        print(f"  ❌ Failed: {stats['failed']}")
        print("=" * 60 + "\n")

        return stats

    def install_to_modules(self, sandbox_dir: str, module_name: str) -> bool:
        """
        Move personalized files from sandbox to modules/ directory.

        Args:
            sandbox_dir: Source directory (sandbox)
            module_name: Name for the module subdirectory

        Returns:
            True if successful, False otherwise
        """
        target_dir = os.path.join("modules", module_name)

        print(f"\n📦 Installing to: {target_dir}")

        try:
            # Create target directory if it doesn't exist
            os.makedirs(target_dir, exist_ok=True)

            # Copy all files from sandbox to target
            for item in os.listdir(sandbox_dir):
                source = os.path.join(sandbox_dir, item)
                dest = os.path.join(target_dir, item)

                if os.path.isdir(source):
                    if os.path.exists(dest):
                        shutil.rmtree(dest)
                    shutil.copytree(source, dest)
                else:
                    shutil.copy2(source, dest)

            print(f"✅ Installation complete: {target_dir}")
            return True

        except Exception as e:
            print(f"❌ Installation failed: {e}")
            return False

    def evolve(self, repo_url: str, module_name: str) -> Dict[str, Any]:
        """
        Main evolution workflow: Download → Verify → Personalize → Install

        Args:
            repo_url: GitHub repository URL or zipball URL
            module_name: Name for the installed module

        Returns:
            Dict with evolution results
        """
        print("\n" + "=" * 70)
        print("🧬 EVOLUTION ENGINE - INITIATING UPDATE SEQUENCE")
        print("=" * 70)
        print(f"Target: {repo_url}")
        print(f"Module: {module_name}")
        print("=" * 70)

        result = {
            "status": "failed",
            "module_name": module_name,
            "repo_url": repo_url,
            "stages": {}
        }

        try:
            # STAGE 1: Download to sandbox
            print("\n🔹 STAGE 1: DOWNLOAD")
            sandbox = self._create_sandbox()
            download_success = self.download_repository(repo_url, sandbox)
            result["stages"]["download"] = download_success

            if not download_success:
                result["error"] = "Download failed"
                return result

            # STAGE 2: Security Check
            print("\n🔹 STAGE 2: SECURITY VERIFICATION")
            python_files = self._get_python_files(sandbox)
            security_ok = self.security_check(python_files)
            result["stages"]["security"] = security_ok

            if not security_ok:
                print("🚫 ABORTING - Security check failed")
                result["error"] = "Security violation detected"
                return result

            # STAGE 3: Personalization (Code Critic)
            print("\n🔹 STAGE 3: CODE PERSONALIZATION")
            personalization_stats = self.personalize_files(sandbox)
            result["stages"]["personalization"] = personalization_stats

            # STAGE 4: Installation
            print("\n🔹 STAGE 4: INSTALLATION")
            install_success = self.install_to_modules(sandbox, module_name)
            result["stages"]["installation"] = install_success

            if install_success:
                result["status"] = "success"

                # Remember this evolution event
                remember(
                    f"Successfully evolved: installed '{module_name}' module from {repo_url}",
                    metadata={
                        "type": "evolution_event",
                        "module": module_name,
                        "repo": repo_url
                    }
                )
            else:
                result["error"] = "Installation failed"

            return result

        except Exception as e:
            result["error"] = str(e)
            print(f"\n❌ Evolution failed: {e}")
            return result

        finally:
            # Always cleanup sandbox
            self._cleanup_sandbox()

            print("\n" + "=" * 70)
            print(f"🧬 EVOLUTION COMPLETE - Status: {result['status'].upper()}")
            print("=" * 70 + "\n")


if __name__ == "__main__":
    # Test the Evolution Engine
    print("O.R.I.O.N. EVOLUTION ENGINE TEST")
    print("=" * 70 + "\n")

    engine = EvolutionEngine()

    # Example: Evolve a small utility library
    # (Replace with actual repo URL for real testing)
    test_repo = "https://github.com/snakers4/silero-vad/zipball/master"

    print("⚠️ TEST MODE - This would download and install a real repository")
    print("Uncomment the line below to run a real evolution:")
    print(f"# result = engine.evolve('{test_repo}', 'silero_vad')")
    print("\n✅ Evolution Engine initialized and ready")
