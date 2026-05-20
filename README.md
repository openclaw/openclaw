# ClaWorks

**Enterprise robot runtime** — event-driven, ontology-native, playbook-powered, A2A-connected.

> ClaWorks is built on the [OpenClaw](https://github.com/openclaw/openclaw) foundation (currently synced to upstream `main`).  
> OpenClaw users can connect to ClaWorks via [@claworks/openclaw-extension](https://github.com/claworks/openclaw-claworks-extension).

Runtime: **Node 24 (recommended) or Node 22.19+** (same as upstream OpenClaw).

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
cd /path/to/claworks
pnpm install
pnpm claworks:init
pnpm claworks:gateway
```

Standalone CLI (isolated from a co-installed OpenClaw on port 18789):

```bash
node claworks.mjs gateway run --port 18800 --bind loopback
# default state: ~/.claworks/claworks.json
```

See `docs/design/STANDALONE-RUN.md` and `docs/design/UPSTREAM-SYNC.md`.

## Architecture

```
packages/claworks-runtime/   ← @claworks/runtime (EventKernel, planes, interfaces)
extensions/claworks-robot/   ← OpenClaw thin plugin (api.* glue only)
claworks.mjs                 ← Product CLI entry (~/.claworks isolation)
src/**                       ← OpenClaw core (track upstream; minimal ClaWorks deltas)
```

## Repos

| Repo                                   | Purpose                   |
| -------------------------------------- | ------------------------- |
| `claworks/claworks`                    | Robot runtime (this repo) |
| `claworks/openclaw-claworks-extension` | OpenClaw bridge plugin    |
| `claworks/claworks-packs`              | Industry ontology packs   |

## Upstream

```bash
git fetch upstream main
git merge upstream/main
# Resolve conflicts per docs/design/UPSTREAM-SYNC.md
pnpm install && pnpm build && pnpm claworks:smoke
```

Internal TypeScript identifiers stay OpenClaw-compatible to minimize merge conflicts.

## License

MIT
