---
title: Skills
summary: "Manage agent capabilities, native skills, and display settings for tools."
---

# Skills

The **Skills** section allows you to manage the specialized capabilities available to your agents.

## Skills vs. Commands

Operator1 distinguishes between how tools are triggered:

| Feature      | Triggered By        | Location                   |
| :----------- | :------------------ | :------------------------- |
| **Skills**   | Agents (autonomous) | `ui-next` Skills sidebar   |
| **Commands** | Users (manual `/`)  | `ui-next` Commands sidebar |

## Skill Management

In the Skills dashboard, you can:

- **Enable/Disable**: Toggle individual skills (e.g., `browser`, `memory`, `terminal`) globally.
- **Configure**: Set default parameters for native skills.
- **Registry**: Sync and install new skills from ClawHub or private registries.

## Native Skills

Core capabilities like **QMD Search**, **File Handling**, and **Terminal Access** are managed as native skills. You can review their individual performance metrics and success rates in the Activity tab.

## Display Settings

Configure how tool calls appear in the chat interface:

- **Auto-expand**: Always show full tool input/output.
- **Collapse**: Show only the tool name and status (recommended for long-running tasks).
