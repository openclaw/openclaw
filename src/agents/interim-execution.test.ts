import { describe, expect, it } from "vitest";
import { isLikelyInterimExecutionMessage } from "./interim-execution.js";

describe("isLikelyInterimExecutionMessage", () => {
  it("accepts short acknowledgement placeholders", () => {
    expect(isLikelyInterimExecutionMessage("on it")).toBe(true);
    expect(isLikelyInterimExecutionMessage("working on it, it'll auto-announce when done")).toBe(
      true,
    );
    expect(isLikelyInterimExecutionMessage("我继续执行，完成后回报")).toBe(true);
  });

  it("rejects substantive final content", () => {
    expect(
      isLikelyInterimExecutionMessage("Here are the final results and the next concrete steps."),
    ).toBe(false);
    expect(isLikelyInterimExecutionMessage("The total should be about $40.")).toBe(false);
    expect(isLikelyInterimExecutionMessage("You should have your summary ready by tomorrow.")).toBe(
      false,
    );
    expect(isLikelyInterimExecutionMessage("我已经看完图，下面是我的判断和还要改的地方。")).toBe(
      false,
    );
  });

  it("accepts future-tense promises that still need background execution", () => {
    expect(
      isLikelyInterimExecutionMessage(
        "你说得对。我先把这张结果图取出来并看一眼，看完后我再只回复你我的判断。",
      ),
    ).toBe(true);
    expect(isLikelyInterimExecutionMessage("好的，我会先检查一下日志，然后再给你结论。")).toBe(
      true,
    );
    expect(isLikelyInterimExecutionMessage("我来确认一下配置，确认完再同步你。")).toBe(true);
    expect(isLikelyInterimExecutionMessage("Let me check the logs and I'll get back to you.")).toBe(
      true,
    );
  });

  it("rejects blockers and generic processing notes", () => {
    expect(
      isLikelyInterimExecutionMessage("当前阻塞：我没有拿到最终图，需要你先确认登录状态。"),
    ).toBe(false);
    expect(isLikelyInterimExecutionMessage("我继续执行，但需要你先确认登录状态。")).toBe(false);
    expect(isLikelyInterimExecutionMessage("处理中最大的风险是旧结果页还没刷新。")).toBe(false);
  });

  it("rejects non-execution language that looks future-tense", () => {
    expect(isLikelyInterimExecutionMessage("我会建议你先升级 Node 版本。")).toBe(false);
    expect(isLikelyInterimExecutionMessage("我先简单说一下结论：这件事不建议做。")).toBe(false);
  });

  it("rejects empty text", () => {
    expect(isLikelyInterimExecutionMessage("")).toBe(false);
    expect(isLikelyInterimExecutionMessage("   ")).toBe(false);
  });
});
