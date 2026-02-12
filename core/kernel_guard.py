"""
O.R.I.O.N. CORE MODULE: THE SECURITY OFFICER
=============================================
This file is part of THE VAULT - Immutable system files.
Status: PROTECTED - No external updates allowed.

The Kernel Guard ensures that the Core Identity remains immutable
and protected from unauthorized modifications during self-updates.
"""

import os
from typing import List, Set, Tuple
from pathlib import Path


# THE VAULT - These paths define O.R.I.O.N.'s immutable identity
PROTECTED_PATHS: List[str] = [
    "core/",                    # All core modules
    "safety_protocols.py",      # Safety and ethics rules
    "identity.py",              # System identity and values
    "CLAUDE.md",                # Token governance and core instructions
    "kernel_guard.py",          # This file itself (recursive protection)
]


class KernelGuard:
    """
    The Security Officer - Enforces the separation between
    immutable Core (Identity) and mutable Modules (Skills).
    """

    def __init__(self, protected_paths: List[str] = None):
        """
        Initialize the Kernel Guard with protected paths.

        Args:
            protected_paths: List of paths to protect (default: PROTECTED_PATHS)
        """
        self.protected_paths = protected_paths or PROTECTED_PATHS
        print("🛡️ Kernel Guard initialized")
        print(f"   Protected paths: {len(self.protected_paths)}")
        for path in self.protected_paths:
            print(f"   - {path}")

    def _normalize_path(self, file_path: str) -> str:
        """
        Normalize a file path for comparison.

        Args:
            file_path: Path to normalize

        Returns:
            Normalized path string
        """
        # Convert to Path object for cross-platform compatibility
        path = Path(file_path)
        # Normalize and convert back to string with forward slashes
        return str(path.as_posix())

    def _is_protected(self, file_path: str) -> Tuple[bool, str]:
        """
        Check if a single file is in a protected path.

        Args:
            file_path: Path to check

        Returns:
            Tuple of (is_protected: bool, matched_rule: str)
        """
        normalized_file = self._normalize_path(file_path)

        for protected_path in self.protected_paths:
            normalized_protected = self._normalize_path(protected_path)

            # Check if file is in protected directory
            if normalized_protected.endswith('/'):
                # It's a directory - check if file is inside it
                if normalized_file.startswith(normalized_protected):
                    return True, protected_path
            else:
                # It's a specific file - check for exact match
                if normalized_file == normalized_protected or \
                   normalized_file.endswith('/' + normalized_protected):
                    return True, protected_path

        return False, ""

    def verify_integrity(self, file_list: List[str], verbose: bool = True) -> bool:
        """
        Verify that NO files in the list are in protected paths.

        This is the main security check called by the Evolution Engine.

        Args:
            file_list: List of file paths to check
            verbose: Print detailed output (default: True)

        Returns:
            True if ALL files are safe (none protected)
            False if ANY file violates protection
        """
        if verbose:
            print("\n" + "=" * 60)
            print("🔒 KERNEL GUARD - INTEGRITY VERIFICATION")
            print("=" * 60)
            print(f"Checking {len(file_list)} files against protected paths...")

        violations: List[Tuple[str, str]] = []

        for file_path in file_list:
            is_protected, matched_rule = self._is_protected(file_path)
            if is_protected:
                violations.append((file_path, matched_rule))

        # Report results
        if violations:
            print("\n❌ SECURITY VIOLATION DETECTED!")
            print(f"   {len(violations)} file(s) attempt to modify protected paths:")
            for file_path, rule in violations:
                print(f"   - {file_path}")
                print(f"     Blocked by rule: {rule}")
            print("\n🚫 UPDATE REJECTED - Core Identity must remain immutable")
            print("=" * 60 + "\n")
            return False
        else:
            if verbose:
                print("✅ All files passed security check")
                print("   No protected paths affected")
                print("=" * 60 + "\n")
            return True

    def get_safe_files(self, file_list: List[str]) -> List[str]:
        """
        Filter a file list to only include safe (non-protected) files.

        Args:
            file_list: List of file paths

        Returns:
            List of files that are NOT protected
        """
        safe_files = []
        for file_path in file_list:
            is_protected, _ = self._is_protected(file_path)
            if not is_protected:
                safe_files.append(file_path)

        return safe_files

    def add_protection(self, path: str) -> None:
        """
        Add a new path to the protected list.

        Args:
            path: Path to protect
        """
        if path not in self.protected_paths:
            self.protected_paths.append(path)
            print(f"🔒 Added protection: {path}")

    def list_protected_paths(self) -> List[str]:
        """
        Get the current list of protected paths.

        Returns:
            List of protected paths
        """
        return self.protected_paths.copy()


# Singleton instance
_guard_instance = None

def get_guard() -> KernelGuard:
    """Get or create the global Kernel Guard instance."""
    global _guard_instance
    if _guard_instance is None:
        _guard_instance = KernelGuard()
    return _guard_instance


def verify_integrity(file_list: List[str], verbose: bool = True) -> bool:
    """
    Convenience function for integrity verification.

    Args:
        file_list: List of file paths to check
        verbose: Print detailed output

    Returns:
        True if safe, False if protected paths detected
    """
    return get_guard().verify_integrity(file_list, verbose)


if __name__ == "__main__":
    # Test the Kernel Guard
    print("O.R.I.O.N. KERNEL GUARD TEST")
    print("=" * 60 + "\n")

    guard = KernelGuard()

    # Test case 1: Safe update (modules only)
    print("Test 1: Safe module update")
    safe_files = [
        "modules/new_skill.py",
        "modules/dream.py",
        "modules/scout.py"
    ]
    result1 = guard.verify_integrity(safe_files)
    assert result1 == True, "Safe files should pass"

    # Test case 2: Unsafe update (touching core)
    print("\nTest 2: Unsafe core modification")
    unsafe_files = [
        "modules/new_skill.py",
        "core/memory.py",  # PROTECTED!
        "modules/helper.py"
    ]
    result2 = guard.verify_integrity(unsafe_files)
    assert result2 == False, "Protected files should fail"

    # Test case 3: Specific protected file
    print("\nTest 3: Identity file protection")
    identity_files = [
        "identity.py",  # PROTECTED!
        "utils.py"
    ]
    result3 = guard.verify_integrity(identity_files)
    assert result3 == False, "Identity file should be protected"

    print("\n✅ All tests passed - Kernel Guard is functioning correctly")
