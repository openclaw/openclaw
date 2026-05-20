import { describe, it, expect } from "vitest";
import {
  definePackManifest,
  defineObjectType,
  definePlaybook,
  objectTypeToYaml,
  playbookToYaml,
  step,
} from "./index.js";

describe("definePackManifest", () => {
  it("validates required fields", () => {
    expect(() =>
      definePackManifest({
        id: "",
        name: "X",
        version: "1.0.0",
        license: "MIT",
        provides: { objectTypes: [], playbooks: [], actionTypes: [] },
      }),
    ).toThrow("id");
    expect(() =>
      definePackManifest({
        id: "x",
        name: "X",
        version: "",
        license: "MIT",
        provides: { objectTypes: [], playbooks: [], actionTypes: [] },
      }),
    ).toThrow("version");
  });

  it("returns manifest unchanged when valid", () => {
    const m = definePackManifest({
      id: "my-pack",
      name: "My Pack",
      version: "1.0.0",
      license: "MIT",
      provides: { objectTypes: ["Sensor"], playbooks: ["check_sensor"], actionTypes: [] },
    });
    expect(m.id).toBe("my-pack");
  });
});

describe("defineObjectType + objectTypeToYaml", () => {
  it("validates required fields", () => {
    expect(() => defineObjectType({ name: "", fields: [] })).toThrow();
  });

  it("generates valid YAML", () => {
    const ot = defineObjectType({
      name: "Sensor",
      displayName: "传感器",
      primaryKey: "sensor_id",
      fields: [
        { name: "sensor_id", type: "string", required: true },
        { name: "value", type: "number", required: true },
        { name: "unit", type: "string" },
      ],
    });
    const yaml = objectTypeToYaml(ot);
    expect(yaml).toContain("name: Sensor");
    expect(yaml).toContain("primaryKey: sensor_id");
    expect(yaml).toContain("- name: sensor_id");
    expect(yaml).toContain("type: number");
    expect(yaml).toContain("required: true");
  });
});

describe("step builders", () => {
  it("step.memRead returns correct shape", () => {
    const s = step.memRead("s1", "pump-001", "baseline_pressure", "mem");
    expect(s).toEqual({
      kind: "memory_read",
      id: "s1",
      subject: "pump-001",
      key: "baseline_pressure",
      output: "mem",
    });
  });

  it("step.memWrite returns correct shape with optional fields", () => {
    const s = step.memWrite("s1", "pump-001", "baseline_vibration", "12.5", {
      category: "baseline",
      confidence: 0.95,
    });
    expect(s.kind).toBe("memory_write");
    expect(s.confidence).toBe(0.95);
    expect(s.value).toBe("12.5");
  });

  it("step.publish returns correct shape", () => {
    const s = step.publish("s1", "alarm.created", { equipment_id: "pump-001" });
    expect(s.kind).toBe("publish_event");
    expect(s.eventType).toBe("alarm.created");
    expect(s.payload?.equipment_id).toBe("pump-001");
  });

  it("step.cond creates condition with then/else branches", () => {
    const s = step.cond(
      "cond1",
      "confidence >= 0.75",
      [step.publish("emit", "alarm.created")],
      [step.fn("noop1", "noop", {})],
    );
    expect(s.kind).toBe("condition");
    expect(s.then).toHaveLength(1);
    expect(s.else).toHaveLength(1);
  });

  it("step.llm, step.action, step.hitl return expected kinds", () => {
    expect(step.llm("s1", "分析设备", "result").kind).toBe("llm");
    expect(step.action("s1", "WorkOrder.create", {}).kind).toBe("action");
    expect(step.hitl("s1", "确认吗?", ["是", "否"], "decision").kind).toBe("hitl");
    expect(step.a2a("s1", "pipeline-robot", "检查压力").kind).toBe("a2a_delegate");
    expect(step.subagent("s1", "分析日志").kind).toBe("subagent");
  });
});

describe("definePlaybook + playbookToYaml", () => {
  it("validates id and pack", () => {
    expect(() =>
      definePlaybook({ id: "", name: "X", pack: "base", trigger: { kind: "manual" }, steps: [] }),
    ).toThrow("id");
    expect(() =>
      definePlaybook({ id: "x", name: "X", pack: "", trigger: { kind: "manual" }, steps: [] }),
    ).toThrow("pack");
  });

  it("generates valid YAML with memory steps", () => {
    const pb = definePlaybook({
      id: "learn_sensor_baseline",
      name: "传感器基线学习",
      pack: "process-industry",
      trigger: { kind: "event", pattern: "sensor.reading.stable" },
      steps: [
        step.memRead("read_old", "{{sensor_id}}", "baseline", "old_baseline"),
        step.cond("decide", "not old_baseline.found", [
          step.memWrite("write_new", "{{sensor_id}}", "baseline", "{{value}}", {
            category: "baseline",
            confidence: 0.95,
          }),
          step.notify("notify", "传感器 {{sensor_id}} 基线已更新"),
        ]),
      ],
    });
    const yaml = playbookToYaml(pb);
    expect(yaml).toContain("id: learn_sensor_baseline");
    expect(yaml).toContain("kind: event");
    expect(yaml).toContain("pattern: sensor.reading.stable");
    expect(yaml).toContain("kind: memory_read");
    expect(yaml).toContain("kind: condition");
    expect(yaml).toContain("kind: memory_write");
    expect(yaml).toContain("kind: notification");
  });
});
