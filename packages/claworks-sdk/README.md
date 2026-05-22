# @claworks/sdk

**ClaWorks Extension Pack SDK** — type-safe helpers for authoring ObjectTypes, Playbooks, and Pack manifests.

```bash
pnpm add @claworks/sdk
```

---

## Quick Start

```typescript
import {
  definePackManifest,
  defineObjectType,
  definePlaybook,
  step,
  objectTypeToYaml,
  playbookToYaml,
} from "@claworks/sdk";
import { writePack } from "@claworks/sdk/write";

// 1. Declare manifest
const manifest = definePackManifest({
  id: "my-pack",
  name: "My Industry Pack",
  version: "1.0.0",
  license: "MIT",
  provides: {
    objectTypes: ["Equipment"],
    playbooks: ["diagnose_alarm"],
    actionTypes: [],
  },
});

// 2. Define ObjectType
const Equipment = defineObjectType({
  name: "Equipment",
  displayName: "设备",
  fields: [
    { name: "equipment_id", type: "string", required: true },
    { name: "status", type: "string" },
    { name: "location", type: "string" },
  ],
});

// 3. Define Playbook
const diagnoseAlarm = definePlaybook({
  id: "diagnose_alarm",
  name: "诊断设备告警",
  pack: "my-pack",
  trigger: { kind: "event", pattern: "alarm.created" },
  steps: [
    step.action(
      "query_equipment",
      "objectstore.query",
      {
        type_name: "Equipment",
        filters: { equipment_id: "{{ event.payload.equipment_id }}" },
      },
      { output: "equipment" },
    ),
    step.llm(
      "diagnose",
      "设备: {{ steps.equipment.result }}\n告警: {{ event.payload.description }}\n请给出诊断和处置建议。",
      "diagnosis",
    ),
    step.hitl(
      "confirm",
      "确认执行处置方案？\n{{ steps.diagnosis.result }}",
      ["确认", "取消"],
      "decision",
    ),
    step.notify("done", "处置完成: {{ steps.decision }}"),
  ],
});

// 4. Write pack to disk
await writePack("./my-pack", manifest, [Equipment], [diagnoseAlarm]);
```

This produces:

```
my-pack/
├── pack.json
└── ontology/
    ├── types/
    │   └── Equipment.yaml
    └── playbooks/
        └── diagnose_alarm.yaml
```

---

## API Reference

### Manifest

```typescript
definePackManifest(manifest: PackManifest): PackManifest
```

Validates `id` and `version` are non-empty. Throws on invalid input.

### ObjectType

```typescript
defineObjectType(def: ObjectTypeDef): ObjectTypeDef
objectTypeToYaml(def: ObjectTypeDef): string
```

`FieldType` options: `"string" | "number" | "boolean" | "date"`

### Playbook

```typescript
definePlaybook(draft: PlaybookDraft): PlaybookDraft
playbookToYaml(draft: PlaybookDraft): string
```

### Triggers

```typescript
// Event trigger
{ kind: "event", pattern: "alarm.*", condition?: "payload.severity > 5" }

// Cron schedule
{ kind: "schedule", cron: "0 8 * * *", timezone?: "Asia/Shanghai" }

// Manual (API / IM trigger only)
{ kind: "manual" }
```

### Step Builders

| Builder                                            | Step kind       | Description                  |
| -------------------------------------------------- | --------------- | ---------------------------- |
| `step.notify(id, message, channels?)`              | `notification`  | Send IM message              |
| `step.llm(id, prompt, output, opts?)`              | `llm`           | LLM completion               |
| `step.action(id, apiName, params, opts?)`          | `action`        | Object CRUD or custom action |
| `step.fn(id, fnApiName, params, output?)`          | `function`      | Custom function call         |
| `step.memRead(id, subject, key, output)`           | `memory_read`   | Read robot memory            |
| `step.memWrite(id, subject, key, value, opts?)`    | `memory_write`  | Write robot memory           |
| `step.publish(id, eventType, payload?, opts?)`     | `publish_event` | Publish event to kernel      |
| `step.hitl(id, message, options, output, opts?)`   | `hitl`          | Human-in-the-loop gate       |
| `step.cond(id, ifExpr, then, else?)`               | `condition`     | Conditional branch           |
| `step.connector(id, connectorId, method, params?)` | `connector`     | Invoke external connector    |
| `step.subPlaybook(id, playbookId, input?)`         | `playbook`      | Run nested Playbook          |
| `step.a2a(id, target, task, opts?)`                | `a2a_delegate`  | Delegate to another robot    |
| `step.subagent(id, prompt, opts?)`                 | `subagent`      | Spawn sub-agent              |
| `step.skill(id, skillId, input?, output?)`         | `skill`         | Run registered skill         |

### writePack (file writer)

```typescript
import { writePack } from "@claworks/sdk/write";

await writePack(
  outputDir: string,        // pack root directory (created if missing)
  manifest: PackManifest,
  objectTypes: ObjectTypeDef[],
  playbooks: PlaybookDraft[],
);
```

Writes `pack.json`, `ontology/types/*.yaml`, and `ontology/playbooks/*.yaml`.

---

## Pack Directory Layout

```
my-pack/
├── pack.json              # PackManifest (required)
├── LICENSE                # Pack-specific license
├── entry.ts               # Optional: custom action handlers, intent mappings
└── ontology/
    ├── types/             # ObjectType YAML files
    │   └── Equipment.yaml
    └── playbooks/         # Playbook YAML files
        └── diagnose_alarm.yaml
```

The `entry.ts` file (optional) registers custom action handlers:

```typescript
import type { PackContribution } from "@claworks/runtime";

const contribution: PackContribution = {
  actionHandlers: {
    "equipment.dispatch_maintenance": async (params, ctx) => {
      // call external MES API
      return { status: "dispatched", work_order: "WO-001" };
    },
  },
  intentMappings: [{ pattern: /设备.*故障|alarm/i, eventType: "alarm.created" }],
};

export default contribution;
```

---

## Template Variables

Playbook steps support Jinja2-style template expressions:

| Expression                   | Value                     |
| ---------------------------- | ------------------------- |
| `{{ event.type }}`           | Triggering event type     |
| `{{ event.payload.field }}`  | Event payload field       |
| `{{ steps.step_id.result }}` | Output of a previous step |
| `{{ robot.name }}`           | Robot name                |

---

## License

MIT — see [LICENSE](LICENSE)
