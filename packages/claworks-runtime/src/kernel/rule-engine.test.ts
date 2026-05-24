import { describe, expect, it } from "vitest";
import { createRuleEngine, type Rule } from "./rule-engine.js";

describe("RuleEngine.addRule", () => {
  it("向已有决策表追加新规则", async () => {
    const engine = createRuleEngine();
    engine.registerTable({
      id: "im.quick_rules",
      name: "IM 快速规则",
      rules: [
        {
          id: "help",
          priority: 100,
          condition: { field: "text", op: "contains", value: "帮助" },
          action: { kind: "publish_event", params: { event_type: "im.help_requested" } },
          stopOnMatch: true,
        },
      ],
    });

    // 动态追加用户纠正学习规则
    const learnedRule: Rule = {
      id: "learned-rule-1",
      name: "用户纠正学习：创建工单",
      priority: 900,
      condition: { field: "text", op: "contains", value: "帮我开个单" },
      action: { kind: "publish_event", params: { event_type: "im.intent.work_order_create" } },
      stopOnMatch: true,
    };
    engine.addRule("im.quick_rules", learnedRule);

    const table = engine.listTables().find((t) => t.id === "im.quick_rules");
    expect(table?.rules).toHaveLength(2);
    expect(table?.rules.find((r) => r.id === "learned-rule-1")).toBeDefined();
  });

  it("追加规则后评估能命中新规则", async () => {
    const engine = createRuleEngine();
    engine.registerTable({ id: "test.table", name: "test", rules: [] });
    engine.addRule("test.table", {
      id: "learned-1",
      priority: 900,
      condition: { field: "text", op: "contains", value: "报障" },
      action: { kind: "publish_event", params: { event_type: "im.intent.fault_report" } },
      stopOnMatch: true,
    });

    const result = await engine.evaluate("test.table", { text: "设备报障" });
    expect(result.matched_rules).toHaveLength(1);
    expect(result.matched_rules[0]?.action.params.event_type).toBe("im.intent.fault_report");
  });

  it("重复 id 的规则会覆盖旧规则", () => {
    const engine = createRuleEngine();
    engine.registerTable({ id: "t", name: "t", rules: [] });

    engine.addRule("t", {
      id: "rule-x",
      priority: 100,
      condition: { field: "v", op: "eq", value: "a" },
      action: { kind: "return", params: { result: "v1" } },
    });
    engine.addRule("t", {
      id: "rule-x",
      priority: 100,
      condition: { field: "v", op: "eq", value: "a" },
      action: { kind: "return", params: { result: "v2" } },
    });

    const table = engine.listTables().find((t) => t.id === "t");
    expect(table?.rules).toHaveLength(1);
    expect(table?.rules[0]?.action.params.result).toBe("v2");
  });

  it("表不存在时自动创建并添加规则", async () => {
    const engine = createRuleEngine();
    engine.addRule("new.table", {
      id: "auto-create-rule",
      priority: 50,
      condition: { field: "x", op: "eq", value: 1 },
      action: { kind: "return", params: { ok: true } },
    });

    const tables = engine.listTables();
    expect(tables.find((t) => t.id === "new.table")).toBeDefined();
    const result = await engine.evaluate("new.table", { x: 1 });
    expect(result.matched_rules).toHaveLength(1);
  });
});
