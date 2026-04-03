# Hello World Plugin

## **Overview**
A simple plugin that logs "Hello World" to the console when loaded. This is a basic example to demonstrate how to create an OpenClaw plugin.

## **Files**
| File            | Purpose                                                                 |
|-----------------|-------------------------------------------------------------------------|
| `plugin.js`     | Contains the plugin logic.                                              |
| `manifest.json` | Metadata for the plugin (name, version, description, etc.).            |

## **How It Works**
1. The plugin exports an `init` function.
2. OpenClaw calls the `init` function when the plugin is loaded.
3. The `init` function logs "Hello World" to the console.

## **Usage**
1. Place the plugin in the OpenClaw plugins directory (e.g., `~/.openclaw/plugins/`).
2. Restart OpenClaw to load the plugin.
3. Check the console for the "Hello World!" message.