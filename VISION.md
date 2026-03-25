## OpenClaw Vision

OpenClaw is the AI that actually does things.
It runs on your devices, in your channels, with your rules.

This document explains the current state and direction of the project.
We are still early, so iteration is fast.
Project overview and developer docs: [`README.md`](README.md)
Contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)

OpenClaw started as a personal playground to learn AI and build something genuinely useful:
an assistant that can run real tasks on a real computer.
It evolved through several names and shells: Warelay -> Clawdbot -> Moltbot -> OpenClaw.

The goal: a personal assistant that is easy to use, supports a wide range of platforms, and respects privacy and security.

The current focus is:

Priority:

- Security and safe defaults
- Bug fixes and stability
- Setup reliability and first-run UX

Next priorities:

- Supporting all major model providers
- Improving support for major messaging channels (and adding a few high-demand ones)
- Performance and test infrastructure
- Better computer-use and agent harness capabilities
- Ergonomics across CLI and web frontend
- Companion apps on macOS, iOS, Android, Windows, and Linux

Contribution rules:

- One PR = one issue/topic. Do not bundle multiple unrelated fixes/features.
- PRs over ~5,000 changed lines are reviewed only in exceptional circumstances.
- Do not open large batches of tiny PRs at once; each PR has review cost.
- For very small related fixes, grouping into one focused PR is encouraged.

## Security

Security in OpenClaw is a deliberate tradeoff: strong defaults without killing capability.
The goal is to stay powerful for real work while making risky paths explicit and operator-controlled.

Canonical security policy and reporting:

- [`SECURITY.md`](SECURITY.md)

We prioritize secure defaults, but also expose clear knobs for trusted high-power workflows.

## Plugins & Memory

OpenClaw has an extensive plugin API.
Core stays lean; optional capability should usually ship as plugins.

Preferred plugin path is npm package distribution plus local extension loading for development.
If you build a plugin, host and maintain it in your own repository.
The bar for adding optional plugins to core is intentionally high.
Plugin docs: [`docs/tools/plugin.md`](docs/tools/plugin.md)
Community plugin listing + PR bar: https://docs.openclaw.ai/plugins/community

Memory is a special plugin slot where only one memory plugin can be active at a time.
Today we ship multiple memory options; over time we plan to converge on one recommended default path.

### Skills

We still ship some bundled skills for baseline UX.
New skills should be published to ClawHub first (`clawhub.ai`), not added to core by default.
Core skill additions should be rare and require a strong product or security reason.

### MCP Support

OpenClaw has first-class native MCP client support built into the gateway runtime.

Configure MCP servers under `tools.mcp.servers` in your config. Connected servers are
exposed to the agent via the `mcp_search` meta-tool (Tier 2 / search mode) or as
individual AgentTools (Tier 1 / direct mode). Server state is stored in SQLite
(`op1_mcp_servers`) — no external middleware required.

### Setup

OpenClaw is currently terminal-first by design.
This keeps setup explicit: users see docs, auth, permissions, and security posture up front.

Long term, we want easier onboarding flows as hardening matures.
We do not want convenience wrappers that hide critical security decisions from users.

### Why TypeScript?

OpenClaw is primarily an orchestration system: prompts, tools, protocols, and integrations.
TypeScript was chosen to keep OpenClaw hackable by default.
It is widely known, fast to iterate in, and easy to read, modify, and extend.

## What We Will Not Merge (For Now)

- New core skills when they can live on ClawHub
- Full-doc translation sets for all docs (deferred; we plan AI-generated translations later)
- Commercial service integrations that do not clearly fit the model-provider category
- Wrapper channels around already supported channels without a clear capability or security gap
- Agent-hierarchy frameworks (manager-of-managers / nested planner trees) as a default architecture
- Heavy orchestration layers that duplicate existing agent and tool infrastructure

This list is a roadmap guardrail, not a law of physics.
Strong user demand and strong technical rationale can change it.
