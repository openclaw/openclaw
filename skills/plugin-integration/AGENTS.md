# AGENTS.md - Plugin Integration Development Skill

## **Purpose**
This file provides guidelines for agents using the **Plugin Integration Development** skill to assist users in creating, developing, and integrating plugins, tools, and commands into OpenClaw.

## **When to Use This Skill**
Invoke this skill when:
- A user wants to create a new OpenClaw plugin, tool, or command.
- A user asks for help with plugin development or integration.
- A user needs examples or templates for OpenClaw plugins.
- A user wants to validate their plugin structure.

## **How to Use This Skill**
### **1. Guide Users Through Plugin Creation**
- Use the `init-plugin.sh` script to create a scaffold for the user’s plugin.
- Explain the purpose of each file in the scaffold (e.g., `manifest.json`, `plugin.js`).

### **2. Provide Examples**
- Direct users to the `examples/` directory for practical demonstrations.
- Explain how the examples work and how they can be modified.

### **3. Validate Plugins**
- Use the `validate-plugin.sh` script to ensure the user’s plugin meets OpenClaw’s requirements.
- Provide feedback on any issues found during validation.

### **4. Integrate Plugins**
- Guide users on placing their plugins in the correct directory (e.g., `~/.openclaw/plugins/`).
- Explain how to restart OpenClaw to load the plugin.

## **Key Files and Directories**
| Path                          | Purpose                                                                                     |
|-------------------------------|---------------------------------------------------------------------------------------------|
| `SKILL.md`                    | Main documentation for the skill.                                                          |
| `SOUL.md`                     | Defines the persona and tone for the skill.                                                |
| `examples/`                   | Contains example plugins and commands.                                                     |
| `scripts/init-plugin.sh`      | Script to initialize a new plugin scaffold.                                                |
| `scripts/validate-plugin.sh`  | Script to validate plugin structure and metadata.                                          |
| `references/api-reference.md` | Documentation for OpenClaw's plugin API.                                                   |
| `references/cli-reference.md` | Documentation for OpenClaw CLI commands related to plugin management.                     |

## **Best Practices for Agents**
- **Encourage Experimentation**: Remind users that examples are meant to be modified.
- **Emphasize Documentation**: Ensure users document their plugins with a `README.md` file.
- **Validate Early**: Encourage users to validate their plugins before integration.
- **Provide Context**: Explain why certain files or structures are necessary.

## **Troubleshooting**
- **Plugin Not Loading**: Check the `manifest.json` file for errors and ensure the plugin is in the correct directory.
- **Errors in Logic**: Use `console.log` or OpenClaw’s logging utilities to debug issues.
- **Validation Failures**: Provide specific feedback on what failed and how to fix it.

## **Contributing**
Agents are encouraged to contribute improvements to this skill by submitting pull requests or issues on the OpenClaw GitHub repository.