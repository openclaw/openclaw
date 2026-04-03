#!/usr/bin/env python3
"""
Setup Validator Script

This script checks for common security misconfigurations and setup issues in OpenClaw.
It validates permissions, plugin safety, sandboxing, and dependency versions.
"""

import os
import subprocess
import sys
import json
from pathlib import Path

# Constants
OPENCLAW_DIR = os.path.expanduser("~/.openclaw")
CONFIG_FILE = os.path.join(OPENCLAW_DIR, "config.yaml")
PLUGIN_DIR = os.path.join(OPENCLAW_DIR, "plugins")


def check_permissions():
    """Check for excessive permissions on OpenClaw directories and files."""
    issues = []
    
    # Check OpenClaw directory
    if os.path.exists(OPENCLAW_DIR):
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
    """Check for unsafe plugins using the correct OpenClaw plugin manifest."""
    issues = []
    
    if not os.path.exists(PLUGIN_DIR):
        return issues
    
    # OpenClaw plugins use openclaw.plugin.json, not manifest.yaml or manifest.json
    for plugin in os.listdir(PLUGIN_DIR):
        plugin_path = os.path.join(PLUGIN_DIR, plugin)
        if os.path.isdir(plugin_path):
            manifest_path = os.path.join(plugin_path, "openclaw.plugin.json")
            if not os.path.exists(manifest_path):
                issues.append({
                    "check": "Unsafe Plugin",
                    "description": f"Plugin '{plugin}' lacks an openclaw.plugin.json manifest file.",
                    "fix": f"Remove the plugin with `openclaw plugins remove {plugin}` or add a valid manifest."
                })
            else:
                # Validate manifest is valid JSON
                try:
                    with open(manifest_path, 'r') as f:
                        manifest = json.load(f)
                    # Check for required fields
                    required = ['name', 'version']
                    missing = [f for f in required if f not in manifest]
                    if missing:
                        issues.append({
                            "check": "Invalid Plugin Manifest",
                            "description": f"Plugin '{plugin}' manifest missing required fields: {missing}",
                            "fix": f"Add missing fields to {manifest_path}"
                        })
                except json.JSONDecodeError as e:
                    issues.append({
                        "check": "Invalid Plugin Manifest",
                        "description": f"Plugin '{plugin}' has invalid JSON in manifest: {e}",
                        "fix": f"Fix the JSON syntax in {manifest_path}"
                    })
    
    return issues


def check_sandboxing():
    """Check if sandboxing is properly configured."""
    issues = []
    
    # Check for sandbox config in OpenClaw config
    # OpenClaw uses config.yaml or config.json
    config_yaml = os.path.join(OPENCLAW_DIR, "config.yaml")
    config_json = os.path.join(OPENCLAW_DIR, "config.json")
    
    if not os.path.exists(config_yaml) and not os.path.exists(config_json):
        issues.append({
            "check": "Missing Configuration",
            "description": "No OpenClaw config file found.",
            "fix": "Run `openclaw config init` to create a default configuration."
        })
        return issues
    
    # Check if sandbox settings exist (YAML or JSON)
    # Note: OpenClaw may not have explicit sandbox config - this is informational
    sandbox_configured = False
    
    if os.path.exists(config_yaml):
        try:
            import yaml
            with open(config_yaml, 'r') as f:
                config = yaml.safe_load(f) or {}
            if 'sandbox' in config or 'security' in config:
                sandbox_configured = True
        except:
            pass
    
    if not sandbox_configured and os.path.exists(config_json):
        try:
            with open(config_json, 'r') as f:
                config = json.load(f)
            if 'sandbox' in config or 'security' in config:
                sandbox_configured = True
        except:
            pass
    
    # This is informational, not an error - OpenClaw has built-in sandboxing
    if not sandbox_configured:
        issues.append({
            "check": "Sandboxing Info",
            "description": "No explicit sandbox configuration found. OpenClaw uses built-in sandboxing by default.",
            "fix": "Optional: Configure custom sandbox settings in config.yaml if needed."
        })
    
    return issues


def check_dependencies():
    """Check for outdated dependencies using npm (OpenClaw is a Node package)."""
    issues = []
    
    # OpenClaw is distributed via npm, not pip
    try:
        result = subprocess.run(
            ["npm", "list", "-g", "openclaw", "--json"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            if data.get('dependencies', {}).get('openclaw'):
                version = data['dependencies']['openclaw'].get('version', 'unknown')
                # Check against latest
                latest_result = subprocess.run(
                    ["npm", "view", "openclaw", "version"],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                if latest_result.returncode == 0:
                    latest_version = latest_result.stdout.strip()
                    if version != latest_version:
                        issues.append({
                            "check": "Outdated Dependencies",
                            "description": f"OpenClaw version {version} is outdated (latest: {latest_version}).",
                            "fix": "Update OpenClaw with `npm update -g openclaw`."
                        })
    except subprocess.TimeoutExpired:
        issues.append({
            "check": "Dependency Check Timeout",
            "description": "Failed to check OpenClaw version (timeout).",
            "fix": "Ensure npm is available and run `npm list -g openclaw` manually."
        })
    except json.JSONDecodeError:
        issues.append({
            "check": "Dependency Check Error",
            "description": "Failed to parse npm output.",
            "fix": "Run `npm list -g openclaw` to check version manually."
        })
    except FileNotFoundError:
        # npm not found - check if openclaw command exists
        try:
            result = subprocess.run(
                ["openclaw", "--version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                version = result.stdout.strip()
                issues.append({
                    "check": "Version Check",
                    "description": f"OpenClaw {version} is installed (npm not available for version check).",
                    "fix": "Install npm for full version checking, or use `openclaw update` to check for updates."
                })
        except:
            issues.append({
                "check": "Dependency Check Unavailable",
                "description": "Neither npm nor openclaw command found.",
                "fix": "Ensure OpenClaw is installed correctly."
            })
    
    return issues


def main():
    """Run all checks and print results."""
    checks = [
        ("Permissions", check_permissions),
        ("Plugins", check_plugins),
        ("Sandboxing", check_sandboxing),
        ("Dependencies", check_dependencies),
    ]
    
    all_issues = []
    for name, check_func in checks:
        print(f"\n📋 Checking {name}...")
        issues = check_func()
        all_issues.extend(issues)
        if issues:
            for issue in issues:
                severity = "⚠️ " if "Info" in issue.get("check", "") else "🚨"
                print(f"  {severity} {issue['check']}: {issue['description']}")
        else:
            print(f"  ✅ No issues found")
    
    print("\n" + "="*60)
    if not all_issues:
        print("✅ All checks passed! Setup is secure.")
        return 0
    
    # Filter actual errors from informational items
    errors = [i for i in all_issues if "Info" not in i.get("check", "")]
    
    if errors:
        print(f"🚨 {len(errors)} issue(s) detected:")
        for issue in errors:
            print(f"\n[{issue['check']}]")
            print(f"  {issue['description']}")
            print(f"  Fix: {issue['fix']}")
        return 1
    else:
        print(f"ℹ️ {len(all_issues)} informational item(s):")
        for issue in all_issues:
            print(f"  - {issue['check']}: {issue['description']}")
        return 0


if __name__ == "__main__":
    sys.exit(main())