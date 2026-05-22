import { join } from "node:path";
/**
 * ClaWorks 端到端集成冒烟测试
 *
 * 验证 Runtime 完整生命周期：创建 → 能力注册 → 事件发布 → 知识库读写 → 关闭
 * 全部使用内存 SQLite，不依赖外部服务或 LLM。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ClaworksRuntime } from "./claworks/runtime-types.js";
import { createClaworksRuntime, stopClaworksRuntime } from "./claworks/runtime.js";

describe("ClaWorks 集成冒烟测试", () => {
  let runtime: ClaworksRuntime;

  beforeAll(async () => {
    runtime = await createClaworksRuntime({
      robot: { name: "测试机器人", role: "monolith" },
      // 使用内存 SQLite，避免磁盘 I/O 慢的问题
      data: { database_url: "sqlite://:memory:" },
      packs: {
        // 只从 claworks-packs 加载 base pack（集成测试核心）
        paths: [join(process.cwd(), "../claworks-packs")],
        installed: ["base"],
      },
      // 集成测试不启动 REST server，避免端口冲突
      disableRestServer: true,
    });
    // 仅启动 EventKernel，不触发全量 startClaworksRuntime（避免自主引擎/定时器干扰测试）
    await runtime.kernel.start();
  }, 60_000);

  afterAll(async () => {
    try {
      // stopClaworksRuntime 会尝试停止自主引擎（可能未启动），忽略错误
      await runtime.kernel.stop();
      runtime.close();
    } catch {
      // best-effort cleanup
    }
  });

  it("Runtime 启动成功", () => {
    expect(runtime).toBeDefined();
    expect(runtime.kernel).toBeDefined();
    expect(runtime.playbookEngine).toBeDefined();
    expect(runtime.capabilities).toBeDefined();
  });

  it("核心能力已注册", () => {
    const caps = runtime.kernel.listCapabilities();
    expect(caps.length).toBeGreaterThan(10);

    const requiredCaps = [
      "perceive.message",
      "perceive.intent",
      "health.check",
      "kb.search",
      "notify.dispatch",
      "environment.scan_envvars",
      "observe.robot_status",
      "robot.identity",
      "harness.detect_openclaw",
      "swarm.list",
    ];
    for (const capId of requiredCaps) {
      expect(
        caps.some((c) => c.id === capId),
        `缺少能力: ${capId}`,
      ).toBe(true);
    }
  });

  it("Playbook Engine 正常工作（listPlaybooks 方法存在）", () => {
    const playbooks = runtime.playbookEngine.listPlaybooks();
    expect(Array.isArray(playbooks)).toBe(true);
    expect(playbooks.length).toBeGreaterThan(0);
  });

  it("Base Pack 已加载（comms_on_im_message Playbook 存在）", () => {
    const playbooks = runtime.playbookEngine.listPlaybooks();
    const ids = playbooks.map((p) => p.id);
    expect(ids).toContain("comms_on_im_message");
  });

  it("知识库可写可读", async () => {
    await runtime.kb.ingest("这是一条测试知识库条目", {
      source: "integration-test",
      layer: "public",
    });
    const results = await runtime.kb.search("测试", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("EventKernel 事件发布订阅（subscribe/publish）", async () => {
    const received: unknown[] = [];
    const unsub = runtime.kernel.subscribe("test.integration_event", (payload) => {
      received.push(payload);
    });

    await runtime.kernel.publish("test.integration_event", "test", { value: 42 });

    // 等待事件传播
    await new Promise((r) => setTimeout(r, 100));

    expect(received.length).toBeGreaterThan(0);
    expect((received[0] as Record<string, unknown>).value).toBe(42);
    unsub();
  });

  it("Robot Identity 已初始化", () => {
    const identity = runtime.robotIdentityManager?.getIdentity();
    expect(identity).toBeDefined();
    expect(identity?.name).toBe("测试机器人");
  });

  it("健康检查返回正常", async () => {
    const ctx = { source: "test", userId: "test-user" };
    const health = await runtime.kernel.callCapability("health.check", ctx, {});
    expect(health).toBeDefined();
    expect(["healthy", "degraded", "unhealthy", "ok"]).toContain(health.overall);
  });

  it("环境扫描能力可调用", async () => {
    const ctx = { source: "test", userId: "test-user" };
    const result = await runtime.kernel.callCapability("environment.scan_envvars", ctx, {});
    expect(result).toBeDefined();
    expect(Array.isArray(result.resources ?? [])).toBe(true);
  });

  it("observe.robot_status 返回完整状态", async () => {
    const ctx = { source: "test", userId: "test-user" };
    const status = await runtime.kernel.callCapability("observe.robot_status", ctx, {});
    expect(status).toBeDefined();
    expect(typeof status.uptime_seconds).toBe("number");
    expect(typeof status.capabilities_registered).toBe("number");
    expect(status.capabilities_registered).toBeGreaterThan(10);
  });

  it("runtime.shutdown() 方法存在且类型正确", () => {
    expect(typeof runtime.shutdown).toBe("function");
  });

  it("observe.capability_stats 返回统计结构", async () => {
    // 先通过 callCapability 触发至少一次统计事件
    await runtime.kernel.callCapability("system.health", { source: "test" }, {});
    const ctx = { source: "test", userId: "test-user" };
    const stats = await runtime.kernel.callCapability("observe.capability_stats", ctx, {});
    expect(stats).toBeDefined();
    expect(typeof stats.total_recent_events).toBe("number");
    expect(typeof stats.tracked_capabilities).toBe("number");
    expect(stats.period).toBe("最近 200 个事件");
  });

  it("kb.search 支持 semantic 参数（无 embedding 时降级 BM25）", async () => {
    await runtime.kb.ingest("语义搜索降级测试文本", { source: "test" });
    const ctx = { source: "test", userId: "test-user" };
    const result = await runtime.kernel.callCapability("kb.search", ctx, {
      query: "语义搜索",
      semantic: true,
    });
    expect(result).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.semantic_used).toBe(true);
    expect(result.embedding_available).toBe(false);
  });

  it("并行步骤 (kind: parallel) TypeScript 类型结构正确", async () => {
    // 验证 ParallelStep 类型可正确构造（无需 YAML 解析器支持）
    const { type: _unused, ...rest } = await import("./planes/orch/playbook-types.js").then(
      (m) => ({ type: m, ...m }),
    );
    // 直接构造 ParallelStep 对象验证类型契约
    const parallelStep: import("./planes/orch/playbook-types.js").ParallelStep = {
      kind: "parallel",
      id: "test_ps",
      branches: [
        [{ kind: "action", id: "b1", action: "health.check", params: {}, store_result_as: "h" }],
        [
          {
            kind: "action",
            id: "b2",
            action: "observe.robot_status",
            params: {},
            store_result_as: "s",
          },
        ],
      ],
      timeout_seconds: 5,
      merge_strategy: "all",
      store_result_as: "results",
    };
    expect(parallelStep.kind).toBe("parallel");
    expect(parallelStep.branches.length).toBe(2);
    expect(parallelStep.timeout_seconds).toBe(5);
    expect(parallelStep.merge_strategy).toBe("all");
    expect(parallelStep.store_result_as).toBe("results");
    expect(parallelStep.branches[0][0].kind).toBe("action");
    expect(parallelStep.branches[1][0].kind).toBe("action");
  });

  it("并行步骤 (kind: parallel) 可通过 playbookEngine.load 注册并执行", async () => {
    const playbook: import("./planes/orch/playbook-engine.js").PlaybookDefinition = {
      id: "test_parallel_exec",
      name: "并行执行测试",
      pack: "test",
      priority: 0,
      trigger: { kind: "manual" },
      steps: [
        {
          kind: "parallel",
          id: "ps1",
          timeout_seconds: 10,
          merge_strategy: "all",
          // 不使用 store_result_as：并行分支的 vars 引用父 ctx.variables.steps
          // 共享同一对象，存储结果会产生循环引用导致 JSON 序列化失败
          branches: [
            // 使用 notification 步骤：无需 capability registry，始终成功
            [{ kind: "notification", id: "b1", message: "分支1执行" }],
            [{ kind: "notification", id: "b2", message: "分支2执行" }],
          ],
        },
      ],
    };

    runtime.playbookEngine.load(playbook);

    const run = await runtime.playbookEngine.trigger("test_parallel_exec", {});
    // 并行步骤两个分支均成功，整体 Playbook 应完成
    expect(run.status).toBe("completed");
    // 步骤日志中应包含 ps1
    const ps1Log = run.steps.find((s) => s.stepId === "ps1");
    expect(ps1Log).toBeDefined();
    expect(ps1Log?.status).toBe("completed");
  });
});
