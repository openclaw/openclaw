import { describe, it, expect, vi } from "vitest";
import { EvolutionSyncManager } from "./evolution-sync.js";

// ── 共用 mock 工厂 ─────────────────────────────────────────────────────────

function makeRuntime(
  overrides: Partial<{
    robotId: string;
    cbrCases: Array<{
      problem?: string;
      tags?: string[];
      outcome?: string;
      useCount?: number;
      createdAt?: Date;
    }>;
    playbooksLoaded: unknown[];
    ruleTablesLoaded: unknown[];
    promptsRegistered: unknown[];
    kbIngested: unknown[];
  }> = {},
) {
  const { robotId = "test-robot-001" } = overrides;
  const loadedPlaybooks: unknown[] = overrides.playbooksLoaded ?? [];
  const loadedRuleTables: unknown[] = overrides.ruleTablesLoaded ?? [];
  const registeredPrompts: unknown[] = overrides.promptsRegistered ?? [];
  const kbItems: unknown[] = overrides.kbIngested ?? [];

  return {
    robot: { name: robotId },
    robotIdentityManager: { getIdentity: () => ({ id: robotId }) },
    db: {
      prepare: () => ({
        all: () => [],
      }),
    },
    cbrStore: {
      list: () => overrides.cbrCases ?? [],
    },
    playbookEngine: {
      list: () => [
        { id: "pb_alpha", trigger: { kind: "event", pattern: "alarm.created" }, steps: [{}, {}] },
        { id: "pb_beta", trigger: { kind: "event", pattern: "task.created" }, steps: [{}] },
      ],
      load: vi.fn((def: unknown) => {
        loadedPlaybooks.push(def);
      }),
      loadFromYaml: async (yaml: string, source: string) => {
        loadedPlaybooks.push({ yaml, source });
      },
      trigger: vi.fn(async () => ({ steps: [], status: "completed" })),
    },
    ruleEngine: {
      listRules: () => [{ id: "im.quick_rules.greeting" }, { id: "safety.rules.hazard" }],
      loadTable: vi.fn((t: unknown) => {
        loadedRuleTables.push(t);
      }),
    },
    promptRegistry: {
      list: () => [{ id: "intent_classify" }, { id: "kb_query" }],
      register: vi.fn((id: string, template: string, description: string) => {
        registeredPrompts.push({ id, template, description });
      }),
    },
    kb: {
      ingest: vi.fn(async (content: string, meta: unknown) => {
        kbItems.push({ content, meta });
      }),
    },
    kernel: {
      publish: vi.fn(async () => undefined),
    },
    _loadedPlaybooks: loadedPlaybooks,
    _loadedRuleTables: loadedRuleTables,
    _registeredPrompts: registeredPrompts,
    _kbItems: kbItems,
  };
}

// ── 导出数据测试 ──────────────────────────────────────────────────────────

describe("EvolutionSyncManager.exportEvolutionData", () => {
  it("返回正确的 version 和 robot_id", async () => {
    const runtime = makeRuntime({ robotId: "robot-abc" });
    const manager = new EvolutionSyncManager(runtime as never);

    const data = await manager.exportEvolutionData(7);

    expect(data.version).toBe("1.0");
    expect(data.robot_id).toBe("robot-abc");
    expect(data.exported_at).toBeTruthy();
    expect(typeof data.exported_at).toBe("string");
  });

  it("低置信度意图的 text_preview 长度不超过 20 字符（隐私保护）", async () => {
    const runtime = makeRuntime({
      cbrCases: [
        {
          problem: "这是一段超长的内容，超过二十个字符的测试文本，不应该完整暴露出来",
          tags: ["kb_query"],
          outcome: undefined,
          useCount: 0,
        },
        { problem: "短文本", tags: ["alarm_query"], outcome: "success", useCount: 0 },
      ],
    });
    const manager = new EvolutionSyncManager(runtime as never);

    const data = await manager.exportEvolutionData(7);

    for (const intent of data.low_confidence_intents) {
      expect(intent.text_preview.length).toBeLessThanOrEqual(20);
      expect(intent.text_hash.length).toBeGreaterThan(0);
    }
  });

  it("Playbook manifest 包含注册的所有 Playbook 信息", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const data = await manager.exportEvolutionData();

    expect(data.playbook_manifest).toHaveLength(2);
    const pb = data.playbook_manifest.find((p) => p.id === "pb_alpha");
    expect(pb).toBeDefined();
    expect(pb?.step_count).toBe(2);
    expect(pb?.trigger_pattern).toBe("alarm.created");
  });

  it("rule_table_names 从 ruleEngine.listRules 提取", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const data = await manager.exportEvolutionData();

    expect(data.rule_table_names).toContain("im");
    expect(data.rule_table_names).toContain("safety");
  });

  it("prompt_template_names 从 promptRegistry.list 提取", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const data = await manager.exportEvolutionData();

    expect(data.prompt_template_names).toContain("intent_classify");
    expect(data.prompt_template_names).toContain("kb_query");
  });

  it("DB 查询失败时 failed_executions 返回空数组（容错）", async () => {
    const runtime = makeRuntime();
    // 覆盖 db.prepare 抛出异常
    (runtime.db as { prepare: () => unknown }).prepare = () => {
      throw new Error("db error");
    };
    const manager = new EvolutionSyncManager(runtime as never);

    const data = await manager.exportEvolutionData(3);

    expect(data.failed_executions).toEqual([]);
  });
});

// ── 导入包测试 ────────────────────────────────────────────────────────────

describe("EvolutionSyncManager.importEvolutionPack", () => {
  it("成功导入 Playbook，applied 数组包含对应条目", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const pack = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      generated_by: "claude-sonnet-4-6",
      source_robot_id: "test-robot-001",
      improved_playbooks: [
        { id: "pb_improved_alpha", name: "改进后的 Alpha", steps: [{ id: "step1" }] },
      ],
      summary: "改进了报警响应 Playbook",
    };

    const result = await manager.importEvolutionPack(pack);

    expect(result.success).toBe(true);
    expect(result.applied.some((a) => a.includes("pb_improved_alpha"))).toBe(true);
    expect(runtime._loadedPlaybooks).toHaveLength(1);
  });

  it("成功导入规则表", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const pack = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      generated_by: "gpt-5.5",
      source_robot_id: "test-robot-001",
      updated_rule_tables: [{ name: "im.quick_rules", conditions: [], actions: [] }],
      summary: "更新了快速响应规则",
    };

    const result = await manager.importEvolutionPack(pack);

    expect(result.success).toBe(true);
    expect(runtime.ruleEngine.loadTable).toHaveBeenCalledTimes(1);
  });

  it("成功导入提示词模板", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const pack = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      generated_by: "claude-sonnet-4-6",
      source_robot_id: "test-robot-001",
      improved_prompt_templates: [
        {
          id: "intent_classify",
          template: "新的意图分类模板 {{ message }}",
          description: "优化版",
        },
      ],
      summary: "改进了意图分类提示词",
    };

    const result = await manager.importEvolutionPack(pack);

    expect(result.success).toBe(true);
    expect(runtime.promptRegistry.register).toHaveBeenCalledWith(
      "intent_classify",
      "新的意图分类模板 {{ message }}",
      "优化版",
    );
  });

  it("成功导入 KB 条目", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const pack = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      generated_by: "claude-sonnet-4-6",
      source_robot_id: "test-robot-001",
      kb_additions: [
        { id: "kb_safety_001", content: "安全操作规程第一条：进入生产区域必须穿戴防护装备。" },
      ],
      summary: "新增安全规程知识",
    };

    const result = await manager.importEvolutionPack(pack);

    expect(result.success).toBe(true);
    expect(runtime._kbItems).toHaveLength(1);
    expect((runtime._kbItems[0] as { content: string }).content).toContain("安全操作规程");
  });

  it("部分失败时 success=false，errors 包含失败信息", async () => {
    const runtime = makeRuntime();
    // 让 promptRegistry.register 抛出错误
    runtime.promptRegistry.register = vi.fn(() => {
      throw new Error("registry locked");
    });
    const manager = new EvolutionSyncManager(runtime as never);

    const pack = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      generated_by: "claude-sonnet-4-6",
      source_robot_id: "test-robot-001",
      improved_prompt_templates: [
        { id: "bad_template", template: "{{ fail }}", description: "should fail" },
      ],
      summary: "test failure",
    };

    const result = await manager.importEvolutionPack(pack);

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors![0]).toContain("registry locked");
  });

  it("导入后历史记录更新", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    expect(manager.getHistory()).toHaveLength(0);
    expect(manager.getStatus().total_imported).toBe(0);

    const pack = {
      version: "2.0",
      generated_at: new Date().toISOString(),
      generated_by: "claude-sonnet-4-6",
      source_robot_id: "test-robot-001",
      summary: "第一次进化",
    };

    await manager.importEvolutionPack(pack);

    const history = manager.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].summary).toBe("第一次进化");
    expect(history[0].pack_version).toBe("2.0");
    expect(manager.getStatus().total_imported).toBe(1);
    expect(manager.getStatus().last_summary).toBe("第一次进化");
  });

  it("导入后发布 evolution.pack_imported 事件", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const pack = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      generated_by: "claude-sonnet-4-6",
      source_robot_id: "test-robot-001",
      summary: "事件测试",
    };

    await manager.importEvolutionPack(pack);

    expect(runtime.kernel.publish).toHaveBeenCalledWith(
      "evolution.pack_imported",
      "evolution-sync",
      expect.objectContaining({ pack_version: "1.0", generated_by: "claude-sonnet-4-6" }),
    );
  });

  it("空包（无任何改进）也能成功导入，applied 为空", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const pack = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      generated_by: "claude-sonnet-4-6",
      source_robot_id: "test-robot-001",
      summary: "无改进的探针包",
    };

    const result = await manager.importEvolutionPack(pack);

    expect(result.success).toBe(true);
    expect(result.applied).toHaveLength(0);
  });

  it("sandbox 模式加载 Playbook 并跑回归，通过后发布晋升事件", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const pack = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      generated_by: "claude-sonnet-4-6",
      source_robot_id: "test-robot-001",
      improved_playbooks: [{ id: "pb_sandbox_new", name: "沙盒 Playbook", steps: [] }],
      summary: "沙盒回归测试",
    };

    const result = await manager.importEvolutionPack(pack, { sandbox: true });

    expect(result.sandbox).toBe(true);
    expect(result.success).toBe(true);
    expect(result.pending_promotion).toBe(true);
    expect(result.simulation_results).toHaveLength(1);
    expect(result.simulation_results?.[0]?.passed).toBe(true);
    expect(runtime.playbookEngine.load).toHaveBeenCalled();
    expect(runtime.kernel.publish).toHaveBeenCalledWith(
      "evolution.sandbox_imported",
      "evolution-sync",
      expect.objectContaining({ regression_passed: true }),
    );
    expect(runtime.kernel.publish).toHaveBeenCalledWith(
      "evolution.sandbox_ready_for_promotion",
      "evolution-sync",
      expect.objectContaining({
        hitl_required: true,
        playbook_ids: ["pb_sandbox_new"],
        promotion_id: expect.stringMatching(/^sandbox-1\.0-/),
      }),
    );
    expect(runtime.kernel.publish).toHaveBeenCalledWith(
      "hitl.approval_requested",
      "evolution-sync",
      expect.objectContaining({ promotion_id: expect.stringMatching(/^sandbox-1\.0-/) }),
    );
    expect(runtime.kernel.publish).not.toHaveBeenCalledWith(
      "evolution.pack_imported",
      "evolution-sync",
      expect.anything(),
    );
  });

  it("sandbox 回归失败时不发布晋升事件", async () => {
    const runtime = makeRuntime();
    runtime.playbookEngine.trigger = vi.fn(async () => ({
      steps: [{ stepId: "s1", status: "failed", error: "boom" }],
      status: "failed",
      error: "boom",
    }));
    const manager = new EvolutionSyncManager(runtime as never);

    const pack = {
      version: "1.0",
      generated_at: new Date().toISOString(),
      generated_by: "claude-sonnet-4-6",
      source_robot_id: "test-robot-001",
      improved_playbooks: [{ id: "pb_bad", steps: [{ id: "s1" }] }],
      summary: "应失败",
    };

    const result = await manager.importEvolutionPack(pack, { simulate_only: true });

    expect(result.sandbox).toBe(true);
    expect(result.success).toBe(false);
    expect(result.pending_promotion).toBe(false);
    expect(runtime.kernel.publish).toHaveBeenCalledWith(
      "evolution.sandbox_imported",
      "evolution-sync",
      expect.objectContaining({ regression_passed: false }),
    );
    expect(runtime.kernel.publish).not.toHaveBeenCalledWith(
      "evolution.sandbox_ready_for_promotion",
      "evolution-sync",
      expect.anything(),
    );
  });
});

describe("EvolutionSyncManager.promoteSandbox", () => {
  it("无 approved 时 fail-closed 返回 approval_required", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);
    const pack = {
      version: "2.0",
      generated_at: "2026-05-25T00:00:00.000Z",
      generated_by: "test",
      source_robot_id: "robot-a",
      improved_playbooks: [{ id: "pb_promo", steps: [] }],
      summary: "待晋升",
    };
    await manager.importEvolutionPack(pack, { sandbox: true });
    const pending = manager.listPendingSandboxPromotions();
    expect(pending).toHaveLength(1);

    const result = await manager.promoteSandbox({
      promotion_id: pending[0]!.promotion_id,
      approved: false,
    });
    expect(result.status).toBe("approval_required");
    expect(manager.listPendingSandboxPromotions()).toHaveLength(1);
  });

  it("approved=true 时写入生产并发布 evolution.sandbox_promoted", async () => {
    const runtime = makeRuntime();
    runtime.evolveEngine = {
      deploy: vi.fn(async () => ({ deployed: true, playbook_path: "/tmp/pb.yaml" })),
    };
    const manager = new EvolutionSyncManager(runtime as never);
    const pack = {
      version: "2.1",
      generated_at: "2026-05-25T01:00:00.000Z",
      generated_by: "test",
      source_robot_id: "robot-a",
      improved_playbooks: [{ id: "pb_promo_ok", steps: [] }],
      summary: "晋升测试",
    };
    await manager.importEvolutionPack(pack, { sandbox: true });
    const promotionId = manager.listPendingSandboxPromotions()[0]!.promotion_id;

    const result = await manager.promoteSandbox({ promotion_id: promotionId, approved: true });
    expect(result.status).toBe("promoted");
    expect(manager.listPendingSandboxPromotions()).toHaveLength(0);
    expect(runtime.kernel.publish).toHaveBeenCalledWith(
      "evolution.sandbox_promoted",
      "evolution.promote_sandbox",
      expect.objectContaining({ promotion_id: promotionId, playbook_ids: ["pb_promo_ok"] }),
    );
    expect(runtime.evolveEngine.deploy).toHaveBeenCalled();
  });
});

// ── getStatus / getHistory 测试 ───────────────────────────────────────────

describe("EvolutionSyncManager.getStatus / getHistory", () => {
  it("初始状态：history 为空，last_imported_at 为 null", () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    const status = manager.getStatus();
    expect(status.total_imported).toBe(0);
    expect(status.last_imported_at).toBeNull();
    expect(status.last_summary).toBeNull();
  });

  it("getHistory 返回倒序（最新在前）", async () => {
    const runtime = makeRuntime();
    const manager = new EvolutionSyncManager(runtime as never);

    for (const summary of ["第一批", "第二批", "第三批"]) {
      await manager.importEvolutionPack({
        version: "1.0",
        generated_at: new Date().toISOString(),
        generated_by: "claude-sonnet-4-6",
        source_robot_id: "test-robot-001",
        summary,
      });
    }

    const history = manager.getHistory();
    expect(history[0].summary).toBe("第三批");
    expect(history[2].summary).toBe("第一批");
  });
});
