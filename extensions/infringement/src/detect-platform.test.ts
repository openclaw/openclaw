import { describe, expect, it } from "vitest";
import { detectPlatform } from "./detect-platform.js";

describe("detectPlatform", () => {
  it("maps known domains to platform names (case-insensitive)", () => {
    expect(detectPlatform("https://mp.weixin.qq.com/s/abc")).toBe("微信公众号");
    expect(detectPlatform("https://WEIBO.com/x")).toBe("微博");
    expect(detectPlatform("https://www.toutiao.com/article/1")).toBe("今日头条");
    expect(detectPlatform("https://v.douyin.com/abc")).toBe("抖音");
    expect(detectPlatform("https://www.xiaohongshu.com/x")).toBe("小红书");
    expect(detectPlatform("https://zhihu.com/q/1")).toBe("知乎");
    expect(detectPlatform("https://baijiahao.baidu.com/s")).toBe("百家号");
  });

  it("detects 微信视频号 from free text or the channels host", () => {
    expect(detectPlatform("视频号：某账号 / 视频ID：123 / 标题")).toBe("微信视频号");
    expect(detectPlatform("https://channels.weixin.qq.com/x")).toBe("微信视频号");
  });

  it("returns empty string for unknown urls", () => {
    expect(detectPlatform("https://example.com/x")).toBe("");
    expect(detectPlatform("")).toBe("");
  });
});
