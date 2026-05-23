# Contributing to ClaWorks

Thank you for your interest in contributing to ClaWorks!

There are three main ways to contribute:

1. **Report bugs / request features** — open a GitHub issue
2. **Contribute code** — see [Code Contributions](#code-contributions) below
3. **Publish a Pack** — see [Pack Contributions](#pack-contributions) below

---

## Code Contributions

### Prerequisites

- Node 24 (or 22.19+)
- pnpm 9+

```bash
git clone https://github.com/claworks/claworks.git
cd claworks
pnpm install
pnpm build
```

### Run tests

```bash
pnpm test packages/claworks-runtime
pnpm test extensions/claworks-robot
```

### Architecture overview

```
packages/claworks-runtime/   @claworks/runtime — the open source core you can contribute to
extensions/claworks-robot/   OpenClaw plugin glue — usually you don't need to touch this
packages/claworks-sdk/       Pack author SDK
src/**                       OpenClaw core (track upstream; avoid changes here)
```

**The most impactful contributions are in `packages/claworks-runtime/`.**

### PR guidelines

- Keep `src/**` changes minimal — these track upstream OpenClaw.
- ClaWorks-specific logic goes in `packages/claworks-runtime/`.
- Tests are required for new functionality.
- Run `pnpm check` before submitting.
- Conventional commit style: `feat(runtime): add ...`, `fix(sdk): correct ...`

---

## Pack Contributions

Packs are the primary extension point for ClaWorks. A Pack defines:

- **ObjectTypes** — domain entities with typed fields (YAML)
- **Playbooks** — event-driven automation workflows (YAML)
- **Action handlers** — custom TypeScript functions called from Playbook steps

Community packs live in [`claworks/claworks-packs`](https://github.com/claworks/claworks-packs).

### Quickstart: create a Pack

```bash
mkdir my-pack && cd my-pack
cat > pack.json << 'EOF'
{
  "id": "my-pack",
  "name": "My Pack",
  "version": "0.1.0",
  "license": "MIT",
  "provides": {
    "objectTypes": [],
    "playbooks": [],
    "actionTypes": []
  }
}
EOF
mkdir -p ontology/types ontology/playbooks
```

Or use the SDK to generate YAML programmatically:

```typescript
import { definePackManifest, defineObjectType, definePlaybook, step } from "@claworks/sdk";
import { writePack } from "@claworks/sdk/write";

const manifest = definePackManifest({
  id: "my-pack",
  name: "My Pack",
  version: "0.1.0",
  license: "MIT",
  provides: { objectTypes: ["MyEntity"], playbooks: ["my_playbook"], actionTypes: [] },
});

const MyEntity = defineObjectType({
  name: "MyEntity",
  fields: [
    { name: "id", type: "string", required: true },
    { name: "value", type: "number" },
  ],
});

const myPlaybook = definePlaybook({
  id: "my_playbook",
  name: "My Playbook",
  pack: "my-pack",
  trigger: { kind: "event", pattern: "my.event" },
  steps: [step.notify("say_hello", "Hello from my-pack!")],
});

await writePack("./my-pack", manifest, [MyEntity], [myPlaybook]);
```

### ObjectType YAML format

```yaml
id: Equipment # must match filename (Equipment.yaml)
name: Equipment
displayName: 设备 # optional human-readable name
description: | # optional multi-line description
  Industrial equipment record.
primaryKey: equipment_id
fields:
  - name: equipment_id
    type: string # string | number | boolean | date
    required: true
  - name: status
    type: string
    foreign_key: EquipmentStatus # optional: reference another ObjectType
```

### Playbook YAML format

```yaml
id: on_alarm # must match filename (on_alarm.yaml)
name: Handle Alarm
pack: my-pack
priority: 80 # 0-100; higher runs first when multiple match
trigger:
  kind: event # event | schedule | manual
  pattern: alarm.* # glob pattern matched against event_type
steps:
  - id: step1
    kind: llm
    prompt: |
      Analyze: {{ event.payload.description }}
    output: result
  - id: step2
    kind: notification
    message: "Result: {{ steps.result.result }}"
```

### Available step kinds

| Kind            | What it does                              |
| --------------- | ----------------------------------------- |
| `notification`  | Send message via IM channel               |
| `llm`           | Call LLM with a prompt, store result      |
| `action`        | ObjectStore CRUD or custom action handler |
| `function`      | Call registered function                  |
| `hitl`          | Pause and wait for human decision via IM  |
| `condition`     | if/then/else branching                    |
| `memory_read`   | Read robot long-term memory               |
| `memory_write`  | Write robot long-term memory              |
| `publish_event` | Emit event into EventKernel               |
| `connector`     | Invoke an external system connector       |
| `playbook`      | Run a nested Playbook                     |
| `a2a_delegate`  | Delegate task to another robot            |
| `subagent`      | Spawn an LLM sub-agent                    |
| `skill`         | Run a registered skill                    |

### Custom action handlers (entry.ts)

```typescript
// my-pack/entry.ts
import type { PackContribution } from "@claworks/runtime";

const contribution: PackContribution = {
  actionHandlers: {
    // Called from Playbook steps with kind: action, actionApiName: "mes.create_order"
    "mes.create_order": async (params, ctx) => {
      const resp = await fetch("https://mes.internal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      return resp.json();
    },
  },
  // Map incoming IM messages to events
  intentMappings: [{ pattern: /故障|alarm|fault/i, eventType: "alarm.created" }],
};

export default contribution;
```

### Testing your Pack locally

1. Copy your pack directory to `~/.claworks/packs/my-pack/`
2. Start ClaWorks: `pnpm claworks:gateway`
3. Reload packs: `curl -X POST http://127.0.0.1:18800/v1/packs/reload -H "Authorization: Bearer YOUR_KEY"`
4. Trigger a test event: `curl -X POST http://127.0.0.1:18800/v1/events -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -d '{"event_type":"my.event","source":"test","payload":{}}'`
5. Check run status: `curl http://127.0.0.1:18800/v1/playbooks`

### Publishing to claworks-packs

1. 在 sibling 仓 `claworks-packs/` 根目录新建 `<pack-id>/`（非 `claworks/contrib/packs/`）
2. 包含 `claworks.pack.json`、`README.md`、`ontology/`（及可选 `src/index.ts`）
3. 本地验证：`CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:init`
4. 参考示例：`claworks/contrib/examples/starter-pack/`（可复制结构，真源仍提交到 claworks-packs）

---

## Development Tips

### Watch mode (rebuild on change)

```bash
pnpm claworks:gateway   # starts gateway in watch mode
```

### Inspect EventKernel events

```bash
curl http://127.0.0.1:18800/v1/observation-events -H "Authorization: Bearer YOUR_KEY"
```

### Check RBAC policies

```bash
curl http://127.0.0.1:18800/v1/identity -H "Authorization: Bearer YOUR_KEY"
```

### Doctor check

```bash
curl -X POST http://127.0.0.1:18800/v1/doctor -H "Authorization: Bearer YOUR_KEY"
```

---

## Code of Conduct

Be respectful. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

---

## License

By submitting code or Pack content to this repository, you agree to license your contribution under the MIT License.

Commercial Industry Pack contributions submitted to `claworks/claworks-packs` may use other licenses — specify in the pack's `LICENSE` file.
