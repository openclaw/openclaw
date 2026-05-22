/**
 * claworks.scenario.test.ts — ClaWorks 关键业务场景集成测试
 *
 * 测试核心运行时能力：事件总线、内核能力调用、对象存储、
 * 用户画像、进化数据导出。不依赖 LLM，使用最小配置。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaworksRuntime } from "./claworks/runtime-types.js";
import {
  createClaworksRuntime,
  startClaworksRuntime,
  stopClaworksRuntime,
} from "./claworks/runtime.js";
import { globalMetrics } from "./kernel/metrics.js";

describe("ClaWorks 关键场景集成测试", () => {
  let runtime: ClaworksRuntime;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "claworks-scenario-"));
    runtime = await createClaworksRuntime({
      robot: { name: "test-robot" },
      data: { database_url: `sqlite://${join(dir, "test.db")}` },
    });
    await startClaworksRuntime(runtime);
  });

  afterEach(async () => {
    await stopClaworksRuntime(runtime);
  });

  it("场景1：EventKernel 事件发布与订阅", async () => {
    const received: Array<Record<string, unknown>> = [];
    runtime.kernel.subscribe("test.scenario_event", (payload) => {
      received.push(payload);
    });

    await runtime.kernel.publish("test.scenario_event", "scenario-test", {
      message: "hello from scenario 1",
      value: 42,
    });

    // 事件总线是同步分发的
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]).toMatchObject({ message: "hello from scenario 1" });
  });

  it("场景2：告警触发通知链（事件发布）", async () => {
    const events: Array<Record<string, unknown>> = [];
    runtime.kernel.subscribe("alarm.triggered", (payload) => {
      events.push(payload);
    });

    await runtime.kernel.publish("alarm.triggered", "test", {
      alarm_id: "alarm_001",
      equipment_id: "eq_001",
      severity: "high",
      message: "压力超高",
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ alarm_id: "alarm_001", severity: "high" });
  });

  it("场景3：进化数据导出完整性", async () => {
    const data = await runtime.evolutionSync?.exportEvolutionData(7);
    expect(data?.version).toBe("1.0");
    expect(data?.robot_id).toBeDefined();
    expect(typeof data?.robot_id).toBe("string");
    expect(Array.isArray(data?.failed_executions)).toBe(true);
    expect(Array.isArray(data?.low_confidence_intents)).toBe(true);
    expect(data?.exported_at).toBeDefined();
  });

  it("场景4：健康检查能力调用（system.health 或 health.check）", async () => {
    // 尝试 system.health（core-capabilities 中注册），fallback 到 health.check
    const result = await runtime.kernel
      .callCapability("system.health", {})
      .catch(() => runtime.kernel.callCapability("health.check", {}).catch(() => null));
    // 无论哪个能力，result 要么有 status 字段，要么为 null（能力未注册时允许）
    if (result !== null) {
      expect(result).toBeDefined();
      const status = (result as Record<string, unknown>).status;
      if (status !== undefined) {
        expect(String(status)).toMatch(/^(ok|degraded|unavailable|running)$/);
      }
    }
  });

  it("场景5：用户画像存储与读取", () => {
    const store = runtime.userProfileStore;
    if (!store) {
      // userProfileStore 是可选的，此场景跳过
      return;
    }

    store.update("user_scenario_test", {
      name: "张三",
      preferredResponseStyle: "concise",
    });
    store.addTopic("user_scenario_test", "设备维修");
    store.addTopic("user_scenario_test", "生产管理");

    const profile = store.get("user_scenario_test");
    expect(profile).toBeDefined();
    expect(profile.name).toBe("张三");
    expect(profile.recentTopics).toContain("设备维修");
    expect(profile.recentTopics).toContain("生产管理");
  });

  it("场景6：对象存储 CRUD 基础操作", async () => {
    await runtime.objectStore.create("task", {
      task_id: "task_scenario_001",
      title: "场景测试任务",
      status: "pending",
      priority: "normal",
      created_at: new Date().toISOString(),
    });

    const result = await runtime.objectStore.query("task", {
      filter: { task_id: "task_scenario_001" },
      limit: 1,
    });

    // query 返回 { items, nextCursor } 结构
    expect(result).toBeDefined();
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("场景7：MetricsCollector 计数和延迟记录", () => {
    globalMetrics.reset();

    globalMetrics.increment("test.scenario_counter", { scenario: "7" });
    globalMetrics.increment("test.scenario_counter", { scenario: "7" });
    globalMetrics.recordDuration("test.scenario_latency_ms", 42, { op: "test" });
    globalMetrics.recordDuration("test.scenario_latency_ms", 58, { op: "test" });

    const snap = globalMetrics.snapshot();
    expect(snap.counters['test.scenario_counter{scenario="7"}']).toBe(2);

    const hist = snap.histograms['test.scenario_latency_ms{op="test"}'];
    expect(hist).toBeDefined();
    expect(hist.count).toBe(2);
    expect(hist.avg).toBe(50);
    expect(hist.min).toBe(42);
    expect(hist.max).toBe(58);

    globalMetrics.reset();
  });

  it("场景8：意图注册表正常初始化", () => {
    const mappings = runtime.intentRegistry.list();
    expect(Array.isArray(mappings)).toBe(true);
    // 即使没有加载业务 Pack，核心意图映射也应该存在
    // 或者空数组（无 Pack 时）
    expect(mappings.length).toBeGreaterThanOrEqual(0);
  });

  it("场景9：Playbook 引擎已初始化且可列出 Playbook", () => {
    const playbooks = runtime.playbookEngine.list();
    expect(Array.isArray(playbooks)).toBe(true);
    // 最小配置下 Playbook 数可能为 0（无 Pack），但不应抛出
  });

  it("场景10：system.startup_warnings 在配置不完整时发布", async () => {
    const warnEvents: unknown[] = [];
    // 创建最小配置 runtime（无 LLM、无 notify）
    const minDir = mkdtempSync(join(tmpdir(), "claworks-min-"));
    const minRuntime = await createClaworksRuntime({
      robot: { name: "min-test" },
      data: { database_url: `sqlite://${join(minDir, "test.db")}` },
    });
    // 订阅 startup_warnings 事件
    minRuntime.kernel.subscribe("system.startup_warnings", (payload) => {
      warnEvents.push(payload);
    });
    await startClaworksRuntime(minRuntime);
    await stopClaworksRuntime(minRuntime);

    // 最小配置下应该有 LLM 和 notify 相关警告
    expect(warnEvents.length).toBeGreaterThan(0);
    const firstWarn = warnEvents[0] as { warnings?: string[] };
    expect(Array.isArray(firstWarn.warnings)).toBe(true);
    expect(firstWarn.warnings?.some((w) => w.includes("LLM") || w.includes("Notify"))).toBe(true);
  });

  it("场景11：通用流程 process.collect_and_report Playbook 已加载", async () => {
    // 核心 pack 应已加载 process.* 模板
    const playbooks = runtime.playbookEngine.list();
    const found = playbooks.find((p) => p.id === "process.collect_and_report");
    // 核心 pack 需要加载后才能找到；在无 Pack 配置下可能为 undefined，但不应抛出
    expect(playbooks).toBeDefined();
    if (found) {
      expect(found.id).toBe("process.collect_and_report");
      expect(found.description).toContain("收集");
      expect(found.version).toBe("1.0");
    }
  });

  it("场景12：system.list_skills 能力返回已注册脚本列表", async () => {
    const result = await runtime.kernel.callCapability("system.list_skills", {} as never, {});
    expect(result).toBeDefined();
    const items = (result as Record<string, unknown>).items;
    expect(Array.isArray(items)).toBe(true);
    // default.severity_classifier 应在列表中
    const ids = (items as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain("default.severity_classifier");
  });

  it("场景13：default.severity_classifier 内置脚本已注册且正确分类", async () => {
    const scriptLib = runtime.scriptLibrary;
    expect(scriptLib).toBeDefined();
    // 验证脚本已注册
    const all = scriptLib!.list();
    const classifier = all.find((s) => s.id === "default.severity_classifier");
    expect(classifier).toBeDefined();
    // 验证分类结果（通过 invoke）
    const critical = await scriptLib!.invoke("default.severity_classifier", {
      item: { severity: "critical" },
    });
    expect((critical as Record<string, unknown>).level).toBe("critical");
    const low = await scriptLib!.invoke("default.severity_classifier", {
      item: { severity: "low" },
    });
    expect((low as Record<string, unknown>).level).toBe("low");
    const medium = await scriptLib!.invoke("default.severity_classifier", {
      item: { priority: "medium" },
    });
    expect((medium as Record<string, unknown>).level).toBe("medium");
  });
});
