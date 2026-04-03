# OpenClaw CLI Reference for Plugin Management

## **Overview**
This document provides a reference for OpenClaw CLI commands related to plugin management.

## **Commands**
### **1. Install a Plugin**
Install a plugin into OpenClaw:
```bash
openclaw plugins install <plugin-directory>
```

### **2. Remove a Plugin**
Remove a plugin from OpenClaw:
```bash
openclaw plugins remove <plugin-name>
```

### **3. List Plugins**
List all installed plugins:
```bash
openclaw plugins list
```

### **4. Validate a Plugin**
Validate a plugin's structure and metadata using this skill's script:
```bash
~/.openclaw/skills/plugin-integration/scripts/validate-plugin.sh <plugin-directory>
```

## **Examples**
### **Install a Plugin**
```bash
openclaw plugins install ~/.openclaw/plugins/hello-world
```

### **Remove a Plugin**
```bash
openclaw plugins remove hello-world
```

### **List Plugins**
```bash
openclaw plugins list
```
Output:
```
Installed Plugins:
- hello-world (1.0.0)
- custom-command (1.0.0)
```

### **Validate a Plugin**
```bash
~/.openclaw/skills/plugin-integration/scripts/validate-plugin.sh ~/.openclaw/plugins/my-plugin
```

## **Plugin Manifest**
OpenClaw plugins use `openclaw.plugin.json` (not `manifest.json` or `manifest.yaml`):

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "A description of your plugin",
  "main": "index.js",
  "author": "Your Name",
  "license": "MIT",
  "openclaw": {
    "minVersion": "1.0.0",
    "permissions": []
  }
}
```

## **Best Practices**
- **Validate Before Installing**: Always validate a plugin before installing:
```bash
~/.openclaw/skills/plugin-integration/scripts/validate-plugin.sh <plugin-directory>
```
- **Use Correct Manifest**: Use `openclaw.plugin.json`, not `manifest.json` or `manifest.yaml`
- **Include Documentation**: Add a `README.md` explaining your plugin's purpose and usage
- **Use Absolute Paths**: When installing plugins, use absolute paths to avoid issues