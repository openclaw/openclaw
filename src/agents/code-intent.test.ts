import { describe, expect, it } from "vitest";
import { isCodeIntent } from "./code-intent.js";

describe("isCodeIntent", () => {
  it("returns false for empty or generic chat", () => {
    expect(isCodeIntent("")).toBe(false);
    expect(isCodeIntent("   ")).toBe(false);
    expect(isCodeIntent("你好")).toBe(false);
    expect(isCodeIntent("What's the weather?")).toBe(false);
  });

  it("returns true for Chinese coding phrases", () => {
    expect(isCodeIntent("写一段代码实现排序")).toBe(true);
    expect(isCodeIntent("写个函数计算斐波那契")).toBe(true);
    expect(isCodeIntent("帮我调试一下这个bug")).toBe(true);
    expect(isCodeIntent("实现一个方法")).toBe(true);
  });

  it("returns true for English coding phrases", () => {
    expect(isCodeIntent("write a function to sort")).toBe(true);
    expect(isCodeIntent("implement the code for login")).toBe(true);
    expect(isCodeIntent("fix the code in main.py")).toBe(true);
    expect(isCodeIntent("refactor the function")).toBe(true);
  });

  it("returns true when message contains code block", () => {
    expect(isCodeIntent("check this:\n```js\nconst x = 1;\n```")).toBe(true);
  });

  it("returns true when message mentions file extension", () => {
    expect(isCodeIntent("open src/main" + ".ts and add a handler")).toBe(true);
    expect(isCodeIntent("edit foo.py")).toBe(true);
  });
});
