---
name: project-context
description: "Guidelines and procedures for analyzing arbitrary local project folders. Use when: (1) asked to analyze a folder/repo that is not the current workspace, (2) exploring a new codebase to understand its architecture and rules."
metadata: { "openclaw": { "emoji": "📁", "requires": { "bins": [] } } }
---

# Project Context Analysis

When you are asked to analyze, review, or work on a project folder that is NOT your current workspace root (e.g. `/Users/my/Projects/foo`):

## 1. Locate Configuration

Check the following directories for configuration files:

- `.agent/`
- `.agents/`
- `.github/`
- `.claude/`

## 2. Load Rules & Instructions

Look for and verify the existence of these files in the project root or config directories:

- `RULES.md` / `rules.md`
- `INSTRUCTIONS.md` / `instructions.md`
- `.cursorrules`
- `.windsurfrules`

**Action:** Read these files immediately if found. Their contents define the coding standards, architecture, and behavior for that project.

## 3. Discover Skills

Look for `SKILL.md` files in:

- `.agent/skills/*/SKILL.md`
- `.agents/skills/*/SKILL.md`
- `.github/skills/*/SKILL.md`
- `.claude/skills/*/SKILL.md`

**Action:** If you find them, read the `SKILL.md` content to understand the specific capabilities available for that project. Do not assume you can use them unless you have read their instructions.
