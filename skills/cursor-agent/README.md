# Cursor CLI Agent Skill

This repository contains the definition and documentation for the `cursor-agent` skill, updated for 2026 features.

## Overview

The `cursor-agent` skill encapsulates workflows and commands for the Cursor CLI, enabling efficient AI-pair programming directly from the terminal. This skill includes all modern features from the January 2026 update.

## What's New in v2.0.0

- **Model Switching**: Switch between AI models with `agent models`, `--model` flag, and `/models` command
- **MCP Management**: Enable/disable MCP servers on the fly with `/mcp enable` and `/mcp disable`
- **Rules & Commands**: Create and edit rules directly from CLI with `/rules` and `/commands`
- **Modern Command Interface**: Use `agent` as the primary command (backward compatible with `cursor-agent`)
- **Enhanced Headless Mode**: New flags including `--force`, `--output-format json`, and `--stream-partial-output`
- **Interactive Features**: Context selection with `@`, slash commands, and keyboard shortcuts
- **Cross-Platform Support**: Complete instructions for macOS (including Homebrew), Linux/Ubuntu, and Windows WSL

## Contents

- **SKILL.md**: The core skill definition file containing all commands, workflows, and usage instructions
- **README.md**: This file, providing an overview and quick reference

## Quick Start

Install the Cursor CLI:
```bash
# Standard installation (macOS, Linux, WSL)
curl https://cursor.com/install -fsS | bash

# Homebrew (macOS only)
brew install --cask cursor-cli
```

Authenticate:
```bash
agent login
```

Start an interactive session:
```bash
agent
```

Switch models:
```bash
agent models
```

## Usage

Refer to `SKILL.md` for comprehensive instructions on:
- Installation and authentication
- Interactive and non-interactive modes
- Model switching and configuration
- MCP server management
- Rules and commands creation
- Slash commands and keyboard shortcuts
- Workflows for code review, refactoring, debugging, and CI/CD integration
