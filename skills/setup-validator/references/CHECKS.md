# Setup Validator Checks

This document describes the checks performed by the **Setup Validator** skill. Each check includes a description, potential risks, and recommended fixes.

## 1. Excessive Permissions
### Description
Checks if OpenClaw or its plugins have excessive file or directory permissions.

### Risks
- Unauthorized access to sensitive files.
- Potential for privilege escalation attacks.

### Recommended Fix
- Restrict permissions to the minimum required:
  ```bash
  chmod 750 ~/.openclaw
  chmod 640 ~/.openclaw/config.yaml
  ```

## 2. Unsafe Plugins
### Description
Identifies plugins installed from untrusted sources or with known vulnerabilities.

### Risks
- Malicious plugins can execute arbitrary code.
- Vulnerable plugins may expose sensitive data.

### Recommended Fix
- Remove unsafe plugins:
  ```bash
  openclaw plugin remove <plugin-name>
  ```
- Install plugins only from trusted sources.

## 3. Missing Sandboxing
### Description
Validates that sandboxing is properly configured for OpenClaw and its plugins.

### Risks
- Unrestricted access to system resources.
- Potential for sandbox escapes.

### Recommended Fix
- Ensure sandboxing is enabled in `~/.openclaw/config.yaml`:
  ```yaml
  sandbox:
    enabled: true
    restrictions:
      network: true
      filesystem: true
  ```

## 4. Outdated Dependencies
### Description
Checks for outdated or vulnerable dependencies in OpenClaw and its plugins.

### Risks
- Known vulnerabilities in dependencies may be exploited.
- Compatibility issues with newer system components.

### Recommended Fix
- Update dependencies:
  ```bash
  pip install --upgrade openclaw
  openclaw plugin update --all
  ```

## Example Output
```plaintext
[WARNING] Excessive permissions detected for OpenClaw.
- Fix: Run `chmod 750 ~/.openclaw` to restrict permissions.

[WARNING] Unsafe plugin detected: example-plugin.
- Fix: Remove the plugin with `openclaw plugin remove example-plugin`.
```