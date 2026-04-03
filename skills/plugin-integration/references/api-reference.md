# OpenClaw Plugin API Reference

## **Overview**
This document provides a reference for OpenClaw's plugin API. Plugins can extend OpenClaw's functionality by adding new tools, commands, or integrations.

## **Plugin Structure**
A plugin consists of:
- A `manifest.json` file containing metadata.
- A main JavaScript file (e.g., `plugin.js` or `command.js`).

### **`manifest.json`**
| Field        | Type     | Description                                                                                     |
|--------------|----------|-------------------------------------------------------------------------------------------------|
| `name`       | string   | Name of the plugin.                                                                             |
| `version`    | string   | Version of the plugin (e.g., `1.0.0`).                                                          |
| `description`| string   | Description of the plugin.                                                                      |
| `author`     | string   | Author of the plugin.                                                                            |
| `main`       | string   | Path to the main JavaScript file (e.g., `plugin.js`).                                           |
| `keywords`   | array    | Keywords for the plugin (e.g., `["example", "hello-world"]`).                              |

### **Plugin Types**
#### **1. Plugins**
Plugins are loaded when OpenClaw starts and can expose functions or tools.

**Example:**
```javascript
module.exports = {
  init: () => {
    console.log("Plugin loaded!");
  },
};
```

#### **2. Commands**
Commands are invoked by users and can accept arguments.

**Example:**
```javascript
module.exports = {
  name: "greet",
  description: "Greets the user by name.",
  run: (args) => {
    const name = args[0] || "there";
    console.log(`Hello, ${name}!`);
  },
};
```

## **API Methods**
### **Logging**
```javascript
console.log("Message"); // Log a message
console.error("Error"); // Log an error
```

### **OpenClaw Utilities**
```javascript
const openclaw = require('openclaw');

// Access OpenClaw utilities
openclaw.utils.doSomething();
```

## **Best Practices**
- **Modularity**: Keep plugins small and focused on a single task.
- **Documentation**: Document your plugin with a `README.md` file.
- **Validation**: Validate your plugin structure before integration.
- **Testing**: Test your plugin in a development environment before deploying it.