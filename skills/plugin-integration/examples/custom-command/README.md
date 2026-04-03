# Custom Command Plugin

## **Overview**
A custom command that greets the user by name. This example demonstrates how to create a command that accepts arguments.

## **Files**
| File            | Purpose                                                                 |
|-----------------|-------------------------------------------------------------------------|
| `command.js`    | Contains the command logic.                                             |
| `manifest.json` | Metadata for the command (name, version, description, etc.).           |

## **How It Works**
1. The command exports a `run` function.
2. OpenClaw calls the `run` function with arguments when the command is invoked.
3. The `run` function logs a greeting to the console.

## **Usage**
1. Place the command in the OpenClaw plugins directory (e.g., `~/.openclaw/plugins/`).
2. Restart OpenClaw to load the command.
3. Run the command in OpenClaw:
   ```
   /greet [name]
   ```
   Example:
   ```
   /greet Alice
   ```
   Output:
   ```
   Hello, Alice!
   ```