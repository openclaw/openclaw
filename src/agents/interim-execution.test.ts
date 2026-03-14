import { describe, expect, it } from "vitest";
import { isLikelyInterimExecutionMessage } from "./interim-execution.js";

describe("isLikelyInterimExecutionMessage", () => {
  it("accepts short acknowledgement placeholders", () => {
    expect(isLikelyInterimExecutionMessage("on it")).toBe(true);
    expect(isLikelyInterimExecutionMessage("working on it, it'll auto-announce when done")).toBe(
      true,
    );
    expect(isLikelyInterimExecutionMessage("我继续处理，完成后回报")).toBe(true);
    expect(isLikelyInterimExecutionMessage("我先处理一下，完成后同步")).toBe(true);
  });

  it("rejects substantive final content", () => {
    expect(
      isLikelyInterimExecutionMessage("Here are the final results and the next concrete steps."),
    ).toBe(false);
    expect(isLikelyInterimExecutionMessage("The total should be about $40.")).toBe(false);
    expect(isLikelyInterimExecutionMessage("You should have your summary ready by tomorrow.")).toBe(
      false,
    );
    expect(isLikelyInterimExecutionMessage("我已经处理完成，下面是最终结果和后续建议。")).toBe(
      false,
    );
    expect(
      isLikelyInterimExecutionMessage(
        "我继续处理这个页面的标题、按钮、留白和插图比例，等我把三套方案都整理完再统一回报你最终版本。",
      ),
    ).toBe(false);
    expect(isLikelyInterimExecutionMessage("处理中")).toBe(false);
  });

  it("rejects empty text", () => {
    expect(isLikelyInterimExecutionMessage("")).toBe(false);
    expect(isLikelyInterimExecutionMessage("   ")).toBe(false);
  });
});
