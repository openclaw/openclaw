#!/usr/bin/env python3
"""
Generate Actionable Warnings

This script generates actionable warnings for issues detected by the Setup Validator.
It reads the output of `validate_setup.py` and formats it for user-friendly display.
"""

import json
import sys
from pathlib import Path


def generate_warnings(issues):
    """Generate actionable warnings from detected issues."""
    if not issues:
        print("✅ No issues detected. Setup is secure!")
        return
    
    print("🚨 Actionable Warnings:")
    for issue in issues:
        print(f"\n[WARNING] {issue['check']}")
        print(f"- {issue['description']}")
        print(f"- Fix: {issue['fix']}")


def main():
    """Main function."""
    # Example: Read issues from stdin or file
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r") as f:
            issues = json.load(f)
    else:
        # Mock data for demonstration
        issues = [
            {
                "check": "Excessive Permissions",
                "description": "OpenClaw directory has excessive permissions: 777.",
                "fix": "Run `chmod 750 ~/.openclaw` to restrict permissions."
            },
            {
                "check": "Unsafe Plugin",
                "description": "Plugin 'example-plugin' lacks a manifest file.",
                "fix": "Remove the plugin with `openclaw plugin remove example-plugin`."
            }
        ]
    
    generate_warnings(issues)


if __name__ == "__main__":
    main()