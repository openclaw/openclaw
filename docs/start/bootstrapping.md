---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Agent bootstrapping ritual that seeds the workspace and identity files"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Understanding what happens on the first agent run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Explaining where bootstrapping files live（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging onboarding identity setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Agent Bootstrapping"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sidebarTitle: "Bootstrapping"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent Bootstrapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bootstrapping is the **first‑run** ritual that prepares an agent workspace and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
collects identity details. It happens after onboarding, when the agent starts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for the first time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What bootstrapping does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On the first agent run, OpenClaw bootstraps the workspace (default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/workspace`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Seeds `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runs a short Q&A ritual (one question at a time).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Writes identity + preferences to `IDENTITY.md`, `USER.md`, `SOUL.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Removes `BOOTSTRAP.md` when finished so it only runs once.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where it runs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bootstrapping always runs on the **gateway host**. If the macOS app connects to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
a remote Gateway, the workspace and bootstrapping files live on that remote（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the Gateway runs on another machine, edit workspace files on the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
host (for example, `user@gateway-host:~/.openclaw/workspace`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS app onboarding: [Onboarding](/start/onboarding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Workspace layout: [Agent workspace](/concepts/agent-workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
