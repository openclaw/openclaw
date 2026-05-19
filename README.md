# ClaWorks

**Enterprise robot runtime** — event-driven, ontology-native, playbook-powered, A2A-connected.

> ClaWorks is built on the [OpenClaw](https://github.com/openclaw/openclaw) foundation.  
> OpenClaw users can connect to ClaWorks via [@claworks/openclaw-extension](https://github.com/claworks/openclaw-claworks-extension).

---

## What is ClaWorks?

ClaWorks turns enterprise systems into **autonomous robots** that:

- **React to events** — OT device alarms, MES signals, API callbacks, scheduled triggers
- **Execute playbooks** — deterministic YAML-defined workflows with LLM decision steps
- **Escalate to humans** — HITL gates via existing IM (Feishu/Telegram/Discord)
- **Talk to each other** — A2A protocol for multi-robot mesh deployments
- **Learn and extend** — write new Playbooks and ObjectTypes at runtime via IM

```
OT Device → Alarm Event → EventKernel → PlaybookEngine → WorkOrder Created
                                                       → Feishu HITL Notification
                                                       → Engineer Approves
                                                       → MES Dispatched
```

## vs Palantir AIP

|                    | Palantir AIP        | ClaWorks                         |
| ------------------ | ------------------- | -------------------------------- |
| Deployment         | 6-18 months         | Days                             |
| Expertise required | Deep domain experts | LLM handles business logic       |
| Ontology           | One giant schema    | Small focused per-robot ontology |
| Cross-domain       | Centralized         | A2A mesh (distributed)           |
| Cost               | $$$$                | Open source + commercial packs   |

## Quick Start

```bash
# Install
npm install -g claworks

# Initialize a robot
claworks init my-robot
claworks packs install process-industry

# Start
claworks start
```

## Architecture

```
claworks/                    ← This repo (OpenClaw fork + ClaWorks core)
  src/kernel/                ← EventKernel (event bus + playbook matcher)
  src/planes/data/           ← ObjectStore + OntologyEngine + KB
  src/planes/orch/           ← PlaybookEngine + HITLGate
  src/interfaces/a2a/        ← A2A Server (robot-to-robot)
  src/interfaces/mcp/        ← MCP Server (tool exposure)
  extensions/claworks-robot/ ← Main ClaWorks plugin

openclaw-claworks-extension/ ← Separate repo: OpenClaw bridge plugin
claworks-packs/              ← Separate repo: industry extension packs
```

## Repos

| Repo                                   | Purpose                   |
| -------------------------------------- | ------------------------- |
| `claworks/claworks`                    | Robot runtime (this repo) |
| `claworks/openclaw-claworks-extension` | OpenClaw bridge plugin    |
| `claworks/claworks-packs`              | Industry ontology packs   |

## Upstream

ClaWorks tracks OpenClaw upstream: `git fetch upstream && git merge upstream/main`  
Internal TypeScript identifiers are kept as-is to minimize merge conflicts.

## License

MIT
