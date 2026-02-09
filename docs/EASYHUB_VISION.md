# EasyHub Unified Personal Command Center – Development Guidelines

## Role & Mindset

You are a senior full-stack engineer, system architect, and product designer. You build **modular, AI-assisted systems** that evolve **feature by feature**. You strictly follow scope boundaries and wait for explicit instructions before implementing features.

## Project Vision

Build a **single unified personal management application** that serves as a **central command center** for:

- All my **software tools**
- All my **websites and web platforms**

The system is intended to evolve into a full-featured personal AI assistant, similar to ClawDBot, including:

| Feature | Description |
|---------|-------------|
| Memory | The AI can remember past interactions and context for continuity. |
| Skills | Modular capabilities the AI can use to perform tasks (e.g., scheduling, summarizing, generating content). |
| Tools | Connectors to software and websites, enabling AI-assisted actions after explicit approval. |
| Guidelines | A system to store and apply user-defined rules and best practices for the AI. |
| Multi-AI Support | Ability to plug in multiple AI engines and switch between them for different tasks. |

The goal is to eliminate the need to switch between multiple apps, dashboards, and browser tabs.

## Development Rules (CRITICAL)

1. **Feature-by-Feature Development**
   - Do not build the entire application at once
   - Only implement features when explicitly requested in a separate prompt
   - Each feature must be isolated, modular, and non-breaking

2. **Guideline-Only Prompt**
   - This document defines principles and constraints only
   - No functionality should be implemented based on this file alone

3. **Human-in-the-Loop**
   - AI may analyze and propose actions
   - No action may be executed without explicit user approval

## Architecture Guidelines

### MCP-Based Integration

- Use **MCP (Model Context Protocol)** as the standard interface between AI and:
  - Software tools
  - Websites
- MCP must define:
  - Tool capabilities
  - Permission scopes
  - Controlled execution pathways

### Multi-AI / Multi-Engine Support (REQUIRED)

- The system must support **multiple AI models or engines**
- AI providers must be:
  - Pluggable
  - Replaceable
  - Configurable per task or feature
- No AI provider should be hardcoded
- Architecture must support:
  - Switching models without refactoring core logic
  - Adding new models in the future with minimal effort
- Model selection logic must be abstracted behind a clean interface

### Software & Website Support

- Support:
  - API-based software integrations
  - Website-based integrations (treated as first-class tools)
- Websites may use MCP-compatible wrappers or controlled browser automation
- All write actions require explicit approval

## AI Behavior Rules

AI is allowed to:
- Read data
- Analyze context
- Summarize
- Propose actions

AI is **NOT allowed** to:
- Execute actions
- Modify external systems
- Trigger workflows

…without explicit user approval.

## UI / UX Principles

- Minimalist
- Intuitive
- Easy to configure
- Low cognitive load
- Clear separation between:
  - Information
  - AI suggestions
  - User-approved actions

## Version Control & Collaboration

- Use **GitHub** for this project
- Requirements:
  - Clean commit history
  - Meaningful commit messages
  - Feature-based branching
  - Pull-request–friendly workflow
- Each feature must:
  - Live in its own branch
  - Be mergeable without conflicts

## Documentation Expectations

- Maintain a clear README
- Document:
  - Architectural decisions
  - Assumptions
  - Extension points (tools, websites, AI engines)
- Update documentation incrementally

## What You MUST NOT Do

- ❌ Do not implement features without explicit instruction
- ❌ Do not auto-execute actions
- ❌ Do not hardcode AI providers, tools, or websites
- ❌ Do not over-engineer ahead of requirements

## Decision-Making Rules

- Prefer simplicity over completeness
- Make assumptions explicit
- Design for extensibility, not finality

---

## Gap Analysis: EasyHub vs EasyHub

### What EasyHub Already Has ✅

| EasyHub Feature | EasyHub Implementation |
|-----------------|------------------------|
| Memory | `MEMORY.md`, `memory/*.md` daily logs |
| Skills | Modular skill system with `SKILL.md` files |
| Tools | MCP-style tool integration, browser automation |
| Guidelines | `SOUL.md`, `AGENTS.md`, `TOOLS.md` |
| Multi-AI | Supports Anthropic, OpenAI, Google, etc. via config |
| Human-in-the-Loop | Built-in approval for external actions |
| Multi-Channel | Telegram, WhatsApp, Discord, Signal, Slack, web |

### What Might Be Missing ❓

| Feature | Status | Notes |
|---------|--------|-------|
| Dashboard UI | ❌ Missing | Visual command center (currently chat-only) |
| Per-task AI switching UI | ⚠️ Partial | Model configurable, but no easy UI toggle |
| Website-as-tool wrappers | ⚠️ Partial | Browser automation exists, but no MCP wrapper standard |
| Structured guidelines DB | ⚠️ Partial | File-based, not queryable |

### Recommended Next Features (in order)

1. **Dashboard UI** - Visual hub showing connected tools, recent activity, pending approvals
2. **Website MCP Wrappers** - Standardize website integrations as first-class tools
3. **Guidelines Query System** - Make guidelines searchable/applicable contextually
4. **AI Model Switcher UI** - Easy per-task model selection

---

*This document will evolve as features are implemented.*
