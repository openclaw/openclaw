# Tooling Policy: Tool-First, Build-When-Needed

## Decision order

1. Use existing OpenClaw built-in tools and configured agents.
2. Reuse available hooks or config options.
3. Install mature open-source components when low-risk and maintainable.
4. Build custom module (hook/MCP adapter/script) only if gaps remain.

## Build trigger conditions

- Required data or action is impossible with current tools.
- Manual workaround breaks 24/7 automation.
- ROI of custom build is positive with clear rollback.

## Mandatory before custom build

- Problem statement and expected business impact.
- Design proposal (scope, interfaces, failure modes).
- Rollback plan.
- Human approval via iMessage confirmation.

## Delivery standard

- Start with canary deployment.
- Add health check and error notification.
- Document runbook and ownership.
