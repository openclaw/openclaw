#!/usr/bin/env python3
"""
Setup Validator Script

This script checks for common security misconfigurations and setup issues in OpenClaw.
It validates permissions, plugin safety, sandboxing, and dependency versions.
"""

import os
import subprocess
import sys
import yaml
from pathlib import Path

# Constants
OPENCLAW_DIR = os.path.expanduser("~/.openclaw")
CONFIG_FILE = os.path.join(OPENCLAW_DIR, "config.yaml")
PLUGIN_DIR = os.path.join(OPENCLAW_DIR, "plugins")


def check_permissions():
    """Check for excessive permissions on OpenClaw directories and files."""
    issues = []
    
    # Check OpenClaw directory
    openclaw_mode = os.stat(OPENCLAW_DIR).st_mode
    if openclaw_mode & 0o022:  # World-writable
        issues.append({
            "check": "Excessive Permissions",
            "description": f"OpenClaw directory has excessive permissions: {oct(openclaw_mode)}.",
            "fix": "Run `chmod 750 ~/.openclaw` to restrict permissions."
        })
    
    # Check config file
    if os.path.exists(CONFIG_FILE):
        config_mode = os.stat(CONFIG_FILE).st_mode
        if config_mode & 0o022:  # World-writable
            issues.append({
                "check": "Excessive Permissions",
                "description": f"Config file has excessive permissions: {oct(config_mode)}.",
                "fix": "Run `chmod 640 ~/.openclaw/config.yaml` to restrict permissions."
            })
    
    return issues


def check_plugins():
    """Check for unsafe plugins."""
    issues = []
    
    if not os.path.exists(PLUGIN_DIR):
        return issues
    
    # Example: Check for plugins from untrusted sources
    for plugin in os.listdir(PLUGIN_DIR):
        plugin_path = os.path.join(PLUGIN_DIR, plugin)
        if os.path.isdir(plugin_path):
            # Example condition: Plugin lacks a manifest or signature
            manifest_path = os.path.join(plugin_path, "manifest.yaml")
            if not os.path.exists(manifest_path):
                issues.append({
                    "check": "Unsafe Plugin",
                    "description": f"Plugin '{plugin}' lacks a manifest file.",
                    "fix": f"Remove the plugin with `openclaw plugin remove {plugin}`."
                })
    
    return issues


def check_sandboxing():
    """Check if sandboxing is properly configured."""
    issues = []
    
    if not os.path.exists(CONFIG_FILE):
        issues.append({
            "check": "Missing Sandboxing",
            "description": "Config file not found. Sandboxing may not be configured.",
            "fix": "Ensure sandboxing is enabled in `~/.openclaw/config.yaml`."
        })
        return issues
    
    with open(CONFIG_FILE, "r") as f:
        config = yaml.safe_load(f) or {}
    
    sandbox = config.get("sandbox", {})
    if not sandbox.get("enabled", False):
        issues.append({
            "check": "Missing Sandboxing",
            "description": "Sandboxing is disabled in the config file.",
            "fix": "Enable sandboxing in `~/.openclaw/config.yaml`:"
            """
sandbox:
  enabled: true
  restrictions:
    network: true
    filesystem: true
            """
        })
    
    return issues


def check_dependencies():
    """Check for outdated dependencies."""
    issues = []
    
    # Example: Check OpenClaw version
    try:
        result = subprocess.run(
            ["pip", "show", "openclaw"],
            capture_output=True,
            text=True,
            check=True
        )
        for line in result.stdout.splitlines():
            if line.startswith("Version:"):
                version = line.split(":")[1].strip()
                # Example: Check if version is outdated
                if version < "1.0.0":
                    issues.append({
                        "check": "Outdated Dependencies",
                        "description": f"OpenClaw version {version} is outdated.",
                        "fix": "Update OpenClaw with `pip install --upgrade openclaw`."
                    })
    except subprocess.CalledProcessError:
        issues.append({
            "check": "Outdated Dependencies",
            "description": "Failed to check OpenClaw version.",
            "fix": "Ensure OpenClaw is installed correctly."
        })
    
    return issues


def main():
    """Run all checks and print results."""
    checks = [
        check_permissions,
        check_plugins,
        check_sandboxing,
        check_dependencies,
    ]
    
    issues = []
    for check in checks:
        issues.extend(check())
    
    if not issues:
        print("✅ No issues detected. Setup is secure!")
        return 0
    
    print("🚨 Issues detected:")
    for issue in issues:
        print(f"\n[WARNING] {issue['check']}")
        print(f"- {issue['description']}")
        print(f"- Fix: {issue['fix']}")
    
    return 1


if __name__ == "__main__":
    sys.exit(main())