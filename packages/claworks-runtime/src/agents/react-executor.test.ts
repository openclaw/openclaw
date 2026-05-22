import { describe, it, expect, vi } from "vitest";
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import { runReact } from "./react-executor.js";

const ctx = { sessionId: "test-session", userId: "test-user", source: "test" };

function makeLlm(
  decisions: Array<{
    thought: string;
    action: { capability: string; params: Record<string, unknown> };
    done: boolean;
    conclusion?: string;
  }>,
): ReturnType<typeof vi.fn> {
  let callIdx = 0;
  return vi.fn().mockImplementation(async () => {
    const d = decisions[Math.min(callIdx++, decisions.length - 1)];
    return { text: JSON.stringify(d) };
  });
}

function makeRuntime(
  capabilityIds: string[],
  llmDecisions: Parameters<typeof makeLlm>[0],
  capabilityResponse: unknown = { overall: "healthy" },
): ClaworksRuntime {
  return {
    llmComplete: makeLlm(llmDecisions),
    kernel: {
      listCapabilities: vi.fn().mockReturnValue(capabilityIds.map((id) => ({ id }))),
      callCapability: vi.fn().mockResolvedValue(capabilityResponse),
    },
  } as unknown as ClaworksRuntime;
}

describe("runReact", () => {
  it("应该执行并返回结果", async () => {
    const runtime = makeRuntime(
      ["health.check", "observe.robot_status"],
      [
        { thought: "先检查健康", action: { capability: "health.check", params: {} }, done: false },
        {
          thought: "完成了",
          action: { capability: "health.check", params: {} },
          done: true,
          conclusion: "系统正常运行",
        },
      ],
      { overall: "healthy" },
    );

    const result = await runReact(
      "检查系统健康",
      ["health.check", "observe.robot_status"],
      3,
      runtime,
      ctx,
    );

    expect(result.goal).toBe("检查系统健康");
    expect(result.iterations).toBeDefined();
    expect(Array.isArray(result.iterations)).toBe(true);
    expect(result.iterations.length).toBeGreaterThan(0);
    expect(result.conclusion).toBeDefined();
    expect(result.success).toBe(true);
  });

  it("应该过滤掉黑名单工具", async () => {
    const allTools = [
      "health.check",
      "security.reset_api_key",
      "governance.disable_capability",
      "evolve.deploy",
    ];
    const runtime = makeRuntime(allTools, [
      {
        thought: "完成",
        action: { capability: "health.check", params: {} },
        done: true,
        conclusion: "ok",
      },
    ]);

    await runReact("测试", allTools, 2, runtime, ctx);

    const callCapMock = (runtime.kernel as unknown as { callCapability: ReturnType<typeof vi.fn> })
      .callCapability;
    const calls: string[] = callCapMock.mock.calls.map((c: unknown[]) => String(c[0]));
    const blockedCalls = calls.filter(
      (id) =>
        id.startsWith("security.") ||
        id.startsWith("governance.") ||
        id.startsWith("evolve.deploy"),
    );
    expect(blockedCalls.length).toBe(0);
  });

  it("超过 max_iterations 后应该停止", async () => {
    const runtime = {
      llmComplete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          thought: "继续",
          action: { capability: "health.check", params: {} },
          done: false,
        }),
      }),
      kernel: {
        listCapabilities: vi.fn().mockReturnValue([{ id: "health.check" }]),
        callCapability: vi.fn().mockResolvedValue({ result: "ok" }),
      },
    } as unknown as ClaworksRuntime;

    const result = await runReact("永不完成的目标", ["health.check"], 3, runtime, ctx);
    expect(result.iterations.length).toBeLessThanOrEqual(3);
    // LLM 持续返回 done: false，达到上限后 success=false
    expect(result.success).toBe(false);
  });

  it("工具不在白名单时 observation 应包含错误信息", async () => {
    const runtime = makeRuntime(
      ["health.check"],
      [
        {
          thought: "尝试未注册工具",
          action: { capability: "unknown.tool", params: {} },
          done: false,
        },
        {
          thought: "改用 health.check",
          action: { capability: "health.check", params: {} },
          done: true,
          conclusion: "完成",
        },
      ],
    );

    const result = await runReact("测试", ["health.check"], 3, runtime, ctx);
    const firstObs = result.iterations[0]?.observation as Record<string, string>;
    expect(firstObs.error).toContain("白名单");
  });

  it("LLM 未配置时应在首次迭代终止（conclusion 含失败信息）", async () => {
    const runtime = {
      llmComplete: undefined,
      kernel: {
        listCapabilities: vi.fn().mockReturnValue([{ id: "health.check" }]),
        callCapability: vi.fn(),
      },
    } as unknown as ClaworksRuntime;

    const result = await runReact("目标", ["health.check"], 2, runtime, ctx);
    // LLM 未配置时抛出异常，catch 分支设置 done: true，所以只有 1 次迭代
    expect(result.iterations.length).toBe(1);
    // done: true 设置，success=true（已处理完），但 conclusion 表明失败
    expect(result.conclusion).toContain("失败");
    // thought 中包含错误信息
    expect(result.iterations[0]?.thought).toContain("LLM 调用失败");
  });

  it("iteration 字段应从 1 开始递增", async () => {
    const runtime = makeRuntime(
      ["health.check"],
      [
        { thought: "第一步", action: { capability: "health.check", params: {} }, done: false },
        {
          thought: "第二步完成",
          action: { capability: "health.check", params: {} },
          done: true,
          conclusion: "done",
        },
      ],
    );

    const result = await runReact("计数测试", ["health.check"], 5, runtime, ctx);
    expect(result.iterations[0]?.iteration).toBe(1);
    if (result.iterations.length > 1) {
      expect(result.iterations[1]?.iteration).toBe(2);
    }
  });

  it("工具执行报错时 observation 应包含 error 字段", async () => {
    const runtime = {
      llmComplete: makeLlm([
        {
          thought: "执行工具",
          action: { capability: "health.check", params: {} },
          done: true,
          conclusion: "done",
        },
      ]),
      kernel: {
        listCapabilities: vi.fn().mockReturnValue([{ id: "health.check" }]),
        callCapability: vi.fn().mockRejectedValue(new Error("capability error")),
      },
    } as unknown as ClaworksRuntime;

    const result = await runReact("错误测试", ["health.check"], 2, runtime, ctx);
    const obs = result.iterations[0]?.observation as Record<string, string>;
    expect(obs.error).toBeDefined();
    expect(obs.error).toContain("capability error");
  });

  it("isSafeCapability 应允许 evolve.update 但拒绝 evolve.deploy", async () => {
    const tools = ["evolve.update", "evolve.deploy", "evolve.remove"];
    const runtime = makeRuntime(tools, [
      {
        thought: "完成",
        action: { capability: "evolve.update", params: {} },
        done: true,
        conclusion: "ok",
      },
    ]);

    await runReact("测试", tools, 2, runtime, ctx);
    const callCapMock = (runtime.kernel as unknown as { callCapability: ReturnType<typeof vi.fn> })
      .callCapability;
    const calls: string[] = callCapMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls).not.toContain("evolve.deploy");
    expect(calls).not.toContain("evolve.remove");
  });
});
