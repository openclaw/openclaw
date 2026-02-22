import { describe, it, expect } from "vitest";
import { resolveFeishuApiBase } from "../feishu-stt.js";

describe("resolveFeishuApiBase", () => {
  it("returns feishu base URL by default", () => {
    expect(resolveFeishuApiBase()).toBe("https://open.feishu.cn/open-apis");
    expect(resolveFeishuApiBase("feishu")).toBe("https://open.feishu.cn/open-apis");
  });

  it("returns lark base URL for lark domain", () => {
    expect(resolveFeishuApiBase("lark")).toBe("https://open.larksuite.com/open-apis");
  });

  it("uses custom domain as-is when it starts with http", () => {
    expect(resolveFeishuApiBase("https://custom.example.com")).toBe(
      "https://custom.example.com/open-apis",
    );
  });

  it("trims trailing slashes from custom domain", () => {
    expect(resolveFeishuApiBase("https://custom.example.com///")).toBe(
      "https://custom.example.com/open-apis",
    );
  });
});
