# ClaWorks

**Enterprise robot runtime** — event-driven, ontology-native, playbook-powered, A2A-connected.

> **ClaWorks fork** — enterprise robot runtime forked from [OpenClaw](https://github.com/openclaw/openclaw), synced to upstream `main`.  
> **快速上手**：[QUICKSTART.md](QUICKSTART.md) · **安装与 npm 预检**：[docs/claworks/install.md](docs/claworks/install.md)  
> Official OpenClaw users can connect via [@claworks/openclaw-extension](https://github.com/claworks/openclaw-claworks-extension).

Runtime: **Node 24 (recommended) or Node 22.19+**

---

## What is ClaWorks?

ClaWorks turns enterprise systems into **autonomous robots** that:

- **React to events** — OT device alarms, MES signals, API callbacks, scheduled triggers
- **Execute playbooks** — deterministic YAML-defined workflows with LLM decision steps
- **Escalate to humans** — HITL gates via existing IM (Feishu / Telegram / Discord)
- **Talk to each other** — A2A protocol for multi-robot mesh deployments
- **Learn and extend** — write new Playbooks and ObjectTypes at runtime via IM

```
OT Device ──alarm──▶ EventKernel ──▶ PlaybookEngine ──▶ WorkOrder Created
                                                     ──▶ Feishu HITL Notification
                                                            │ Engineer Approves
                                                            ▼
                                                     MES Dispatched
```

---

## vs Palantir AIP

|                    | Palantir AIP        | ClaWorks                         |
| ------------------ | ------------------- | -------------------------------- |
| Deployment         | 6–18 months         | Days                             |
| Expertise required | Deep domain experts | LLM handles business logic       |
| Ontology           | One giant schema    | Small focused per-robot ontology |
| Cross-domain       | Centralized         | A2A mesh (distributed)           |
| Cost               | $$$$                | Open source + commercial packs   |

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/claworks/claworks.git
cd claworks
pnpm install

# Initialize config (~/.claworks/claworks.json)
pnpm claworks:init

# Start the robot gateway (port 18800, isolated from OpenClaw on 18789)
pnpm claworks:gateway
```

Verify:

```bash
curl http://127.0.0.1:18800/v1/health
```

---

## Repository layout

| 路径                         | 说明                               |
| ---------------------------- | ---------------------------------- |
| `packages/claworks-runtime/` | EventKernel、三平面、REST/MCP/A2A  |
| `extensions/claworks-robot/` | Gateway 插件与 `cw_*` 工具         |
| `connectors/`                | OT 连接器子进程                    |
| `contrib/`                   | 配置片段与示例（**非** Pack 源码） |
| `packs/`                     | 运行时安装目录（git 空）           |
| sibling `claworks-packs/`    | Pack YAML/TS **唯一真源**          |

详见 [`docs/design/DIRECTORY-LAYOUT.md`](docs/design/DIRECTORY-LAYOUT.md) 与 [`docs/design/ECOSYSTEM-EXTENSION-GUIDE.md`](docs/design/ECOSYSTEM-EXTENSION-GUIDE.md)。

**产品阶段**：核心 Phase 0–7 已完成 → 生态扩展。见 [`docs/design/PRODUCT-COMPLETION.md`](docs/design/PRODUCT-COMPLETION.md)。

---

## Core Concepts

| Concept            | What it is                                                                         |
| ------------------ | ---------------------------------------------------------------------------------- |
| **EventKernel**    | Event bus — receives events, matches Playbook triggers                             |
| **ObjectStore**    | Typed document store driven by ontology YAML                                       |
| **PlaybookEngine** | YAML-defined workflow executor with LLM steps and HITL gates                       |
| **Industry Pack**  | A bundle of ObjectTypes + Playbooks for one domain                                 |
| **A2A**            | Agent-to-Agent protocol for multi-robot mesh                                       |
| **Connector**      | Subprocess bridge to external systems (OPC-UA, MQTT, REST…)                        |
| **Capability**     | Named action (`comms.send`, `kb.search`, `llm.scaffold`…) usable in Playbook steps |
| **Scaffold**       | LLM prompt template — enables weak-model-friendly structured output                |
| **Script**         | Pure-code helper (no LLM) — registered by Packs, called via `script.run`           |

---

## Playbook Step Types

| Step kind       | What it does                                                         |
| --------------- | -------------------------------------------------------------------- |
| `notification`  | Send a message via notify bridge                                     |
| `action`        | Call a named capability (`action: comms.send`, `action: kb.search`…) |
| `function`      | Call a built-in function (DiagnoseEquipment, ComputeStats…)          |
| `call_playbook` | Invoke a child Playbook and optionally wait for its output           |
| `skill`         | Call an OpenClaw ClawHub Skill (AI reasoning via embedded agent)     |
| `script`        | Call a registered pure-code script (no LLM)                          |
| `llm`           | Free-form LLM prompt step                                            |
| `scaffold`      | LLM prompt via a named Scaffold template (weak-model safe)           |
| `hitl`          | Request human approval before continuing                             |
| `condition`     | Branch on a condition (`if`/`then`/`else`)                           |
| `parallel`      | Run multiple step branches concurrently                              |
| `memory_read`   | Read from persistent RobotMemory                                     |
| `memory_write`  | Write to persistent RobotMemory                                      |
| `publish_event` | Publish a ClaWorks event to EventKernel                              |

---

## Generic Process Templates

The **core Pack** ships 12 `process.*` Playbook templates covering the most common enterprise automation patterns. Trigger them manually or compose them via `call_playbook`:

| Template                         | Pattern                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `process.collect_and_report`     | Collect data → aggregate → send report                  |
| `process.detect_and_escalate`    | Detect condition → classify severity → escalate         |
| `process.collect_user_input`     | Ask user → validate → store response                    |
| `process.notify_and_track`       | Notify → track acknowledgment → escalate if overdue     |
| `process.request_and_approve`    | Submit request → HITL approval → dispatch               |
| `process.search_and_reply`       | Search KB → LLM-synthesize → reply                      |
| `process.health_check_and_alert` | Health check → alert on failure                         |
| `process.batch_process`          | Process a list of items in sequence                     |
| `process.feedback_and_learn`     | Collect feedback → store learning record                |
| `process.scheduled_broadcast`    | Scheduled periodic broadcast                            |
| `process.sync_and_diff`          | Sync external data → diff with local → resolve changes  |
| `process.validate_and_store`     | Validate incoming data → store if valid → reject if not |

---

## Architecture

```
claworks/claworks (this repo)
│
├── packages/claworks-runtime/    @claworks/runtime — open source core
│   ├── kernel/                   EventKernel · PlaybookEngine · Scheduler
│   ├── planes/data/              ObjectStore · KnowledgeBase · Ontology
│   ├── planes/orch/              Step executor · HITL · Playbook persistence
│   └── interfaces/               REST API · MCP · A2A · Nexus · Connectors
│
├── packages/claworks-sdk/        @claworks/sdk — Pack author toolkit
│
├── extensions/claworks-robot/    OpenClaw plugin glue (api.* only)
│   └── skills/                   AI skills for building / operating robots
│
├── claworks.mjs                  claworks CLI → port 18800, ~/.claworks/
└── src/**                        OpenClaw core (tracked upstream, minimal delta)
```

---

## Open Source & Commercial Model

| Layer                                              | License             | Who uses it                              |
| -------------------------------------------------- | ------------------- | ---------------------------------------- |
| `@claworks/runtime`                                | **MIT** (this repo) | Anyone — self-host, build on, contribute |
| `@claworks/sdk`                                    | **MIT**             | Pack authors                             |
| **Industry Packs** (oil & gas, manufacturing…)     | **Commercial**      | Enterprise customers                     |
| **Enterprise features** (multi-tenant, SSO, audit) | **Commercial**      | Large deployments                        |
| **ClaWorks Cloud**                                 | **SaaS**            | Teams wanting managed hosting            |

The runtime is permanently open source. Commercial packs and enterprise features are sold separately — [contact us](mailto:hi@claworks.ai) or see [claworks.ai](https://claworks.ai).

---

## Writing a Pack

A Pack is a directory with an `ontology/` folder and a `pack.json` manifest.

```
my-pack/
├── pack.json                    # manifest
└── ontology/
    ├── types/
    │   └── Equipment.yaml       # ObjectType definition
    └── playbooks/
        └── diagnose_alarm.yaml  # Playbook definition
```

**pack.json**

```json
{
  "id": "my-pack",
  "name": "My Industry Pack",
  "version": "1.0.0",
  "license": "MIT",
  "provides": {
    "objectTypes": ["Equipment"],
    "playbooks": ["diagnose_alarm"],
    "actionTypes": []
  }
}
```

**Equipment.yaml**

```yaml
id: Equipment
name: Equipment
fields:
  - name: equipment_id
    type: string
    required: true
  - name: status
    type: string
  - name: location
    type: string
```

**diagnose_alarm.yaml**

```yaml
id: diagnose_alarm
name: Diagnose Equipment Alarm
trigger:
  event_type: alarm.created
steps:
  - id: look_up_equipment
    action: objectstore.query
    params:
      type_name: Equipment
      filters:
        equipment_id: "{{ event.payload.equipment_id }}"
  - id: llm_diagnosis
    action: llm.complete
    params:
      prompt: |
        Equipment: {{ steps.look_up_equipment.result }}
        Alarm: {{ event.payload.description }}
        Diagnose and suggest action.
  - id: notify_engineer
    action: notify.send
    params:
      message: "{{ steps.llm_diagnosis.result }}"
      hitl: true
```

See [`contrib/examples/starter-pack/`](contrib/examples/starter-pack/) for a complete runnable example.

Full Pack development guide: [`../claworks-packs/PACK_DEVELOPMENT.md`](../claworks-packs/PACK_DEVELOPMENT.md)  
Full SDK reference: [`packages/claworks-sdk/README.md`](packages/claworks-sdk/README.md)  
Capability reference: [`docs/capability-reference.md`](docs/capability-reference.md)

---

## Evolution & Offline Improvement

ClaWorks supports **offline evolution** — robots in air-gapped deployments can export interaction data, generate improved Playbooks/Scaffolds offline, then import them as a pack:

```bash
# Export evolution data from the running robot
claworks evolution export --output ./evolution-data.zip

# (Offline) AI improves Playbooks/Scaffolds → pack
claworks evolution import --pack ./improved-pack.zip

# Check sync status
claworks evolution status
```

---

## REST API

All endpoints at `http://localhost:18800/v1/` (require `Authorization: Bearer <api_key>` when configured).

| Method | Path                                 | Description                     |
| ------ | ------------------------------------ | ------------------------------- |
| GET    | `/v1/health`                         | Health status + doctor checks   |
| GET    | `/v1/identity`                       | Robot identity and constitution |
| POST   | `/v1/events`                         | Publish an event to EventKernel |
| GET    | `/v1/playbooks`                      | List loaded Playbooks           |
| POST   | `/v1/playbooks/{id}/runs`            | Trigger a Playbook              |
| GET    | `/v1/playbooks/runs/{id}`            | Get run status                  |
| POST   | `/v1/playbooks/{id}/runs/{rid}/hitl` | Submit HITL decision            |
| PUT    | `/v1/playbooks/{id}/yaml`            | Hot-write Playbook YAML         |
| GET    | `/v1/objects/{type}`                 | Query ObjectStore               |
| POST   | `/v1/objects/{type}`                 | Create object                   |
| PATCH  | `/v1/objects/{type}/{id}`            | Update object                   |
| GET    | `/v1/kb/search`                      | Knowledge base semantic search  |
| POST   | `/v1/kb/ingest`                      | Ingest document                 |
| GET    | `/v1/packs`                          | List installed packs            |
| POST   | `/v1/packs/install`                  | Install pack from Nexus         |
| POST   | `/v1/doctor`                         | Run health checks               |
| GET    | `/v1/metrics`                        | Prometheus metrics              |
| GET    | `/.well-known/agent.json`            | A2A agent card                  |

---

## Repos

| Repo                                                                                              | Purpose                                   |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| [`claworks/claworks`](https://github.com/claworks/claworks)                                       | Robot runtime — **this repo**             |
| [`claworks/openclaw-claworks-extension`](https://github.com/claworks/openclaw-claworks-extension) | Bridge plugin for official OpenClaw users |
| [`claworks/claworks-packs`](https://github.com/claworks/claworks-packs)                           | Open community packs                      |

---

## Upstream Sync

ClaWorks tracks OpenClaw upstream with minimal core deltas. To merge upstream:

```bash
git fetch upstream main
git merge upstream/main
# resolve per docs/design/UPSTREAM-SYNC.md
pnpm install && pnpm build && pnpm claworks:smoke
```

Internal TypeScript identifiers stay OpenClaw-compatible to minimize merge conflicts.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Pack contributions welcome in [`claworks/claworks-packs`](https://github.com/claworks/claworks-packs).

---

## License

`@claworks/runtime` and `@claworks/sdk` — **MIT**  
Industry Packs distributed via Nexus — see individual pack licenses.
