---
name: antigravity
description: "Core Antigravity routing and blueprinting tools. Provides access to the intelligent LLM and Skill routers for specialized task orchestration."
metadata:
  {
    "openclaw": { "emoji": "🌀" },
  }
---

# Antigravity Routers

Use these tools to route requests to the most appropriate models and skills.

## Protocols

1. **SREP (Strict Router Enforcement Protocol)**:
   - Refuse to execute file modifications WITHOUT a preceding `llm_router` call to obtain a blueprint.
   - Use `llm_router` for all architecture, design, or logic-heavy tasks.

2. **SDP (Skill Discovery Protocol)**:
   - Mandatory invocation: Every domain-specific task shall be routed through the `skill_router` before implementation begins.

## Tools

### llm_router

Route the prompt to the Smart LLM Router with automatic provider selection.

- **Command**: `node C:/Users/baron/.gemini/antigravity/mcp/llm-router/index.js`
- **Action**: `call`
- **Output**: JSON blueprint or response.

### skill_router

Retrieve applicable skill profiles and constraints.

- **Command**: `node C:/Users/baron/.gemini/antigravity/mcp/skill-router/index.js`
- **Action**: `call`
- **Output**: JSON skill recommendations.
