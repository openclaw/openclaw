import { describe, expect, it } from "vitest";
import { parsePlaybookYaml, parseObjectTypeYaml } from "./yaml-parsers.js";

describe("parsePlaybookYaml", () => {
  it("parses camelCase functionApiName from pack YAML", () => {
    const yaml = `
id: classify_im
trigger:
  kind: event
  pattern: im.*
steps:
  - id: skip
    kind: function
    functionApiName: noop
    params:
      reason: test
`;
    const pb = parsePlaybookYaml(yaml, "base");
    expect(pb.steps[0]).toMatchObject({
      kind: "function",
      functionApiName: "noop",
    });
  });

  it("parses action and function steps from pack YAML", () => {
    const yaml = `
id: ingest_text_to_kb
name: Ingest KB
trigger:
  type: manual
steps:
  - id: ingest
    type: action
    action_api_name: ingest_kb_text
    params:
      text: "hello"
      title: doc1
  - id: diag
    type: function
    function_api_name: DiagnoseEquipment
    params:
      equipment_id: eq-1
`;
    const pb = parsePlaybookYaml(yaml, "process-industry");
    expect(pb.id).toBe("ingest_text_to_kb");
    expect(pb.steps).toHaveLength(2);
    expect(pb.steps[0]).toMatchObject({
      kind: "action",
      actionApiName: "ingest_kb_text",
    });
    expect(pb.steps[1]).toMatchObject({
      kind: "function",
      functionApiName: "DiagnoseEquipment",
    });
  });

  it("parses schedule trigger with type:", () => {
    const yaml = `
id: nightly_sync
trigger:
  type: schedule
  cron: "0 2 * * *"
steps: []
`;
    const pb = parsePlaybookYaml(yaml, "base");
    expect(pb.trigger).toEqual({ kind: "schedule", cron: "0 2 * * *", timezone: undefined });
  });

  it("parses schedule trigger with kind: (new style)", () => {
    const yaml = `
id: robot_self_report
trigger:
  kind: schedule
  cron: "0 8 * * *"
steps: []
`;
    const pb = parsePlaybookYaml(yaml, "base");
    expect(pb.trigger).toMatchObject({ kind: "schedule", cron: "0 8 * * *" });
  });

  it("parses event trigger with kind: pattern:", () => {
    const yaml = `
id: learn_baseline
trigger:
  kind: event
  pattern: equipment.reading.stable
steps: []
`;
    const pb = parsePlaybookYaml(yaml, "base");
    expect(pb.trigger).toMatchObject({ kind: "event", pattern: "equipment.reading.stable" });
  });

  it("parses memory_read step", () => {
    const yaml = `
id: mem_read_test
trigger:
  kind: event
  pattern: test.*
steps:
  - id: read_baseline
    kind: memory_read
    subject: pump-001
    key: baseline_pressure
    output: mem
`;
    const pb = parsePlaybookYaml(yaml, "base");
    expect(pb.steps[0]).toMatchObject({
      kind: "memory_read",
      subject: "pump-001",
      key: "baseline_pressure",
      output: "mem",
    });
  });

  it("parses memory_write step with confidence and category", () => {
    const yaml = `
id: mem_write_test
trigger:
  kind: manual
steps:
  - id: write_baseline
    kind: memory_write
    subject: pump-001
    key: baseline_vibration
    value: "12.5"
    category: baseline
    confidence: 0.95
    source: connector:pump-001
    output: write_result
`;
    const pb = parsePlaybookYaml(yaml, "base");
    expect(pb.steps[0]).toMatchObject({
      kind: "memory_write",
      subject: "pump-001",
      key: "baseline_vibration",
      value: "12.5",
      category: "baseline",
      confidence: 0.95,
      source: "connector:pump-001",
      output: "write_result",
    });
  });

  it("parses publish_event step", () => {
    const yaml = `
id: publish_test
trigger:
  kind: manual
steps:
  - id: emit
    kind: publish_event
    event_type: alarm.created
    source: playbook:test
    payload:
      equipment_id: pump-001
      severity: critical
    output: publish_result
`;
    const pb = parsePlaybookYaml(yaml, "base");
    expect(pb.steps[0]).toMatchObject({
      kind: "publish_event",
      eventType: "alarm.created",
      source: "playbook:test",
      payload: { equipment_id: "pump-001", severity: "critical" },
    });
  });

  it("parses real learn_equipment_baseline playbook YAML", () => {
    const yaml = `
id: learn_equipment_baseline
name: 设备基线学习
trigger:
  kind: event
  pattern: equipment.reading.stable
steps:
  - id: check_existing_baseline
    kind: memory_read
    subject: "{{equipment_id}}"
    key: "baseline_{{metric}}"
    output: existing_baseline
  - id: decide_update
    kind: condition
    if: "not existing_baseline.found"
    then:
      - id: write_baseline
        kind: memory_write
        subject: "{{equipment_id}}"
        key: "baseline_{{metric}}"
        value: "{{value}}"
        category: baseline
        confidence: 0.95
        output: write_result
`;
    const pb = parsePlaybookYaml(yaml, "process-industry");
    expect(pb.trigger).toMatchObject({ kind: "event", pattern: "equipment.reading.stable" });
    expect(pb.steps[0]).toMatchObject({ kind: "memory_read" });
    const cond = pb.steps[1] as { kind: string; then: unknown[] };
    expect(cond.kind).toBe("condition");
    expect(cond.then[0]).toMatchObject({ kind: "memory_write", category: "baseline" });
  });
});

describe("parseObjectTypeYaml", () => {
  it("parses fields array format (new style)", () => {
    const yaml = `
name: RbacPolicy
displayName: RBAC 访问策略
primaryKey: id
fields:
  - name: id
    type: string
    required: true
  - name: action
    type: string
    required: true
  - name: effect
    type: string
    required: true
`;
    const ot = parseObjectTypeYaml(yaml, "base", "RbacPolicy.yaml");
    expect(ot.name).toBe("RbacPolicy");
    expect(ot.primaryKey).toBe("id");
    expect(ot.fields).toHaveLength(3);
    expect(ot.fields[0]).toMatchObject({ name: "id", type: "string", required: true });
    expect(ot.fields[2]).toMatchObject({ name: "effect", type: "string", required: true });
  });

  it("parses properties dict format (legacy)", () => {
    const yaml = `
api_name: Equipment
primary_key: equipment_id
properties:
  equipment_id:
    type: string
    required: true
  name:
    type: string
`;
    const ot = parseObjectTypeYaml(yaml, "process-industry", "equipment.yaml");
    expect(ot.name).toBe("Equipment");
    expect(ot.primaryKey).toBe("equipment_id");
    expect(ot.fields.find((f) => f.name === "equipment_id")).toMatchObject({ required: true });
  });

  it("uses filename as name when neither name nor api_name present", () => {
    const yaml = `
primaryKey: id
fields:
  - name: id
    type: string
`;
    const ot = parseObjectTypeYaml(yaml, "base", "MyType.yaml");
    expect(ot.name).toBe("MyType");
  });
});
