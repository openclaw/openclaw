# OpenClaw CLI Reference for Plugin Management

## **Overview**
This document provides a reference for OpenClaw CLI commands related to plugin management.

## **Commands**
### **1. Load a Plugin**
Load a plugin into OpenClaw:
```bash
openclaw plugin load <plugin-directory>
```

### **2. Unload a Plugin**
Unload a plugin from OpenClaw:
```bash
openclaw plugin unload <plugin-name>
```

### **3. List Plugins**
List all loaded plugins:
```bash
openclaw plugin list
```

### **4. Validate a Plugin**
Validate a plugin's structure and metadata:
```bash
openclaw plugin validate <plugin-directory>
```

## **Examples**
### **Load a Plugin**
```bash
openclaw plugin load ~/.openclaw/plugins/hello-world
```

### **Unload a Plugin**
```bash
openclaw plugin unload hello-world
```

### **List Plugins**
```bash
openclaw plugin list
```
Output:
```
Loaded Plugins:
- hello-world (1.0.0)
- custom-command (1.0.0)
```

## **Best Practices**
- **Validate Before Loading**: Always validate a plugin before loading it:
```bash
openclaw plugin validate ~/.openclaw/plugins/<plugin-directory>
```.
- **Restart OpenClaw**: Restart OpenClaw after loading or unloading plugins to ensure changes take effect.
- **Use Absolute Paths**: When loading plugins, use absolute paths to avoid issues.