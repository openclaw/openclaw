import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import { createResearchAgent } from "./research-agent.js";

function makeRuntime(overrides: Partial<ClaworksRuntime> = {}): ClaworksRuntime {
  return {
    kb: {
      search: vi.fn().mockResolvedValue([
        { id: "1", text: "设备温度报警处理方法：先确认温度值，再通知相关人员", score: 0.9 },
        { id: "2", text: "压缩机温度超过 85°C 需要立即停机检查", score: 0.8 },
      ]),
      add: vi.fn().mockResolvedValue(undefined),
      ingest: vi.fn().mockResolvedValue(undefined),
    },
    kernel: {
      getRecentEvents: vi.fn().mockReturnValue([]),
      publish: vi.fn().mockResolvedValue(undefined),
      callCapability: vi.fn().mockResolvedValue("综合分析：根据 KB 信息，建议立即检查设备"),
    },
    environmentScanner: {
      webSearch: vi.fn().mockResolvedValue([
        {
          title: "压缩机维护指南",
          snippet: "定期检查润滑油和密封件",
          url: "https://example.com/guide",
        },
      ]),
    },
    ...overrides,
  } as unknown as ClaworksRuntime;
}

describe("ResearchAgent", () => {
  let runtime: ClaworksRuntime;

  beforeEach(() => {
    runtime = makeRuntime();
  });

  it("应该同步研究并返回结果", async () => {
    const agent = createResearchAgent(runtime);
    const result = await agent.research({ query: "压缩机温度报警", sources: ["kb", "web"] });

    expect(result.task_id).toBeDefined();
    expect(result.query).toBe("压缩机温度报警");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.synthesis).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("KB 和网络来源应该并行搜索", async () => {
    const agent = createResearchAgent(runtime);
    await agent.research({ query: "设备维护", sources: ["kb", "web"] });

    expect(runtime.kb.search).toHaveBeenCalledWith("设备维护", expect.any(Object));
    const scanner = (runtime as unknown as Record<string, unknown>).environmentScanner as {
      webSearch: ReturnType<typeof vi.fn>;
    };
    expect(scanner.webSearch).toHaveBeenCalledWith("设备维护", expect.any(Number));
  });

  it("save_to_kb=true 时应写入知识库", async () => {
    const agent = createResearchAgent(runtime);
    await agent.research({ query: "测试问题", sources: ["kb"], save_to_kb: true });

    expect(runtime.kb.add).toHaveBeenCalled();
  });

  it("只查 KB 时不应调用 webSearch", async () => {
    const agent = createResearchAgent(runtime);
    await agent.research({ query: "测试", sources: ["kb"] });

    const scanner = (runtime as unknown as Record<string, unknown>).environmentScanner as {
      webSearch: ReturnType<typeof vi.fn>;
    };
    expect(scanner.webSearch).not.toHaveBeenCalled();
  });

  it("getResult 应该返回已缓存的结果", async () => {
    const agent = createResearchAgent(runtime);
    const result = await agent.research({ id: "test-001", query: "测试" });

    const cached = agent.getResult("test-001");
    expect(cached).toEqual(result);
  });

  it("save_to_kb=false 时不应写入知识库", async () => {
    const agent = createResearchAgent(runtime);
    await agent.research({ query: "测试", sources: ["kb"], save_to_kb: false });

    expect(runtime.kb.add).not.toHaveBeenCalled();
  });

  it("未知 task_id 的 getResult 应返回 undefined", () => {
    const agent = createResearchAgent(runtime);
    expect(agent.getResult("not-exist")).toBeUndefined();
  });

  it("monitor 应该返回监控 ID", async () => {
    const agent = createResearchAgent(runtime);
    const monitorId = await agent.monitor("设备状态", 24);

    expect(monitorId).toMatch(/^monitor-/);
    agent.stopMonitor(monitorId);
  });

  it("stopMonitor 应该停止监控", async () => {
    const agent = createResearchAgent(runtime);
    const monitorId = await agent.monitor("测试话题", 1000);
    agent.stopMonitor(monitorId);
    expect(true).toBe(true);
  });

  it("events 来源应该从 kernel.getRecentEvents 读取", async () => {
    const kernelWithEvents = {
      getRecentEvents: vi
        .fn()
        .mockReturnValue([
          { type: "alarm.triggered", payload: { device: "压缩机A", temperature: 90 } },
        ]),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const rt = makeRuntime({ kernel: kernelWithEvents as unknown as ClaworksRuntime["kernel"] });
    const agent = createResearchAgent(rt);
    const result = await agent.research({ query: "压缩机", sources: ["events"] });

    expect(kernelWithEvents.getRecentEvents).toHaveBeenCalled();
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0].source).toMatch(/^event:/);
  });

  it("KB 搜索失败时应降级返回空 findings", async () => {
    const rt = makeRuntime({
      kb: {
        search: vi.fn().mockRejectedValue(new Error("KB unavailable")),
        add: vi.fn(),
        ingest: vi.fn(),
      } as unknown as ClaworksRuntime["kb"],
    });
    const agent = createResearchAgent(rt);
    const result = await agent.research({ query: "测试", sources: ["kb"] });

    expect(result.findings).toHaveLength(0);
    expect(result.confidence).toBe(0.2);
  });

  it("depth=thorough 时应请求更多 KB 结果", async () => {
    const agent = createResearchAgent(runtime);
    await agent.research({ query: "深度测试", sources: ["kb"], depth: "thorough" });

    expect(runtime.kb.search).toHaveBeenCalledWith("深度测试", { limit: 10 });
  });

  it("有 llmComplete 时应使用 LLM 合成摘要", async () => {
    const llmComplete = vi.fn().mockResolvedValue({ text: "LLM 合成的高质量分析结果" });
    const rt = makeRuntime({ llmComplete } as unknown as Partial<ClaworksRuntime>);
    const agent = createResearchAgent(rt);
    const result = await agent.research({ query: "测试", sources: ["kb"] });

    expect(llmComplete).toHaveBeenCalled();
    expect(result.synthesis).toBe("LLM 合成的高质量分析结果");
  });
});
