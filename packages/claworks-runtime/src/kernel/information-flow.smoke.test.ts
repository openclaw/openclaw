/**
 * 信息流全链路冒烟测试（纯函数 + 最小 mock，无 Playbook 引擎 / 网络）
 *
 * patrol payload → buildEventContext → ContextPacket
 * → buildLlmContext(rich) → enriched_prompt 含系统状态 + 领域知识 + 案例
 */
import { describe, expect, it, vi } from "vitest";
import { buildEventContext } from "./event-context.js";
import { buildLlmContext } from "./llm-context-builder.js";

describe("information flow smoke", () => {
  it("patrol payload flows through buildEventContext and rich buildLlmContext", async () => {
    const patrolPayload = {
      pending_runs: 4,
      playbook_count: 11,
      robot_id: "robot-patrol-01",
      ts: 1_700_000_000_000,
      content: "产线 A 巡检完成，发现 2 项待处理维护项",
    };

    const packet = buildEventContext(patrolPayload, "robot.patrol");

    expect(packet.meta).toEqual({
      pending_runs: 4,
      playbook_count: 11,
      robot_id: "robot-patrol-01",
    });
    expect(packet.event_ts).toBe(1_700_000_000_000);
    expect(packet.inferred_domain).toBe("maintenance");

    const fetchDomainKnowledge = vi.fn().mockResolvedValue("巡检 SOP：异常项需在 30 分钟内确认");
    const fetchCases = vi
      .fn()
      .mockResolvedValue([
        "[产线告警] 上次 pump-002 振动超标，更换轴承后恢复",
        "[巡检] 夜班漏检项通过二次复核闭环",
      ]);

    const result = await buildLlmContext(
      {
        prompt: "汇总本次巡检结论并给出建议",
        context_level: "rich",
        domain: "maintenance",
        event_context: packet,
      },
      { fetchDomainKnowledge, fetchCases },
    );

    expect(fetchDomainKnowledge).toHaveBeenCalledWith("maintenance");
    expect(fetchCases).toHaveBeenCalled();
    expect(result.injected_cases).toBe(2);
    expect(result.effective_context_level).toBe("rich");

    expect(result.enriched_prompt).toContain(
      "系统状态: 机器人 robot-patrol-01, 运行中 Playbook 4 个, 共 11 个 Playbook",
    );
    expect(result.enriched_prompt).toContain(
      "领域知识 [maintenance]: 巡检 SOP：异常项需在 30 分钟内确认",
    );
    expect(result.enriched_prompt).toContain("参考案例 (2):");
    expect(result.enriched_prompt).toContain("pump-002 振动超标");
    expect(result.enriched_prompt).toContain("汇总本次巡检结论并给出建议");
  });
});
