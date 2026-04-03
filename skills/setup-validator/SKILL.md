---
name: setup-validator
description: |
  Validate OpenClaw installation safety by checking for common security misconfigurations and setup issues.
  Use this skill during initial setup, periodic heartbeats, or whenever security validation is required.
  Checks include: excessive permissions, unsafe plugins, missing sandboxing, outdated dependencies, and more.
  Provides actionable warnings with fixes and clear documentation for resolving issues.
---

# Setup Validator

## Overview
This skill validates OpenClaw installations for security misconfigurations and setup issues. It runs during initial setup and periodically (e.g., via heartbeats or cron) to ensure ongoing safety.

## Checks
The validator checks for the following issues:

| Check | Description | Reference |
|-------|-------------|-----------|
| **Excessive Permissions** | Ensures OpenClaw and plugins have only necessary permissions. | [CHECKS.md](references/CHECKS.md) |
| **Unsafe Plugins** | Identifies plugins from untrusted sources or with known vulnerabilities. | [CHECKS.md](references/CHECKS.md) |
| **Missing Sandboxing** | Validates that sandboxing is properly configured. | [CHECKS.md](references/CHECKS.md) |
| **Outdated Dependencies** | Checks for outdated or vulnerable dependencies. | [CHECKS.md](references/CHECKS.md) |

See [CHECKS.md](references/CHECKS.md) for detailed descriptions of each check.

## Setup

### Make Scripts Executable
Before using the scripts, ensure they have executable permissions:
```bash
chmod +x ~/.openclaw/skills/setup-validator/scripts/*.py
```

## Usage

### Run Validation
Execute the validation script to check for misconfigurations:
```bash
python scripts/validate_setup.py
```

### Generate Actionable Warnings
If issues are detected, generate actionable warnings with fixes:
```bash
python scripts/generate_warnings.py
```

### Example Output
```plaintext
[WARNING] Excessive permissions detected for OpenClaw.
- Fix: Run `chmod 750 ~/.openclaw` to restrict permissions.

[WARNING] Unsafe plugin detected: example-plugin.
- Fix: Remove the plugin with `openclaw plugin remove example-plugin`.
```

## Documentation
- [Detailed Checks](references/CHECKS.md)
- [Example Fixes](references/EXAMPLE_FIXES.md)

## Periodic Validation
To run this skill periodically (e.g., via cron or heartbeats), add the following to your cron jobs:
```bash
0 * * * * python ~/.openclaw/skills/setup-validator/scripts/validate_setup.py
```