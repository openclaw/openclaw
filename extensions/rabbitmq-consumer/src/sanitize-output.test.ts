import { describe, expect, it } from "vitest";
import { sanitizeInternalRefs } from "./sanitize-output.js";

describe("sanitizeInternalRefs", () => {
  it("removes a backticked workspace path together with its lead-in verb", () => {
    const input = "处置方案已整理完成，保存在 `memory/2026-06-09-深圳农行车贷投诉处置方案.md`。";
    const out = sanitizeInternalRefs(input);
    expect(out).toBe("处置方案已整理完成。");
    expect(out).not.toContain("memory/");
    expect(out).not.toContain("`");
  });

  it("handles other lead-in verbs (位于 / 路径)", () => {
    expect(sanitizeInternalRefs("报告位于 `templates/weekly.md`，请查收。")).toBe("报告，请查收。");
    expect(sanitizeInternalRefs("路径为 `workspace/state/run.json`")).toBe("");
  });

  it("strips a bare (un-backticked) internal path", () => {
    const out = sanitizeInternalRefs("已写入 memory/2026-06-09.md 完成");
    expect(out).not.toContain("memory/");
    expect(out).toContain("已写入");
    expect(out).toContain("完成");
  });

  it("strips the runtime root path", () => {
    expect(sanitizeInternalRefs("凭证在 ~/.openclaw/credentials/web.json 里")).not.toContain(
      ".openclaw",
    );
  });

  it("removes the injected pipeline context prefixes", () => {
    const input = '[userId:126] [topicId:42 topicName:"农行"] 您好';
    const out = sanitizeInternalRefs(input);
    expect(out).toBe("您好");
  });

  it("removes per-user agent session keys and ids", () => {
    expect(sanitizeInternalRefs("run agent:rabbitmq-126:rabbitmq:126:abc done")).toBe("run done");
    expect(sanitizeInternalRefs("由 rabbitmq-962 处理")).toBe("由 处理");
  });

  it("does NOT mangle a legitimate customer article URL", () => {
    const url = "详情见 https://weibo.com/u/123/sessions/456 报道";
    expect(sanitizeInternalRefs(url)).toBe(url);
  });

  it("does NOT mangle an OSS file delivery link (file_share output)", () => {
    // The file_share tool's whole purpose is putting this URL in the reply;
    // sanitization must never strip or truncate it.
    const reply =
      "文件已生成，点击下载：\n" +
      "https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/6/12/1781234567_a3f8c21e.docx\n" +
      "（链接长期有效）";
    expect(sanitizeInternalRefs(reply)).toBe(reply);
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "本周舆情整体平稳，负面提及 12 条，建议持续关注。";
    expect(sanitizeInternalRefs(prose)).toBe(prose);
  });

  it("is a no-op on empty input", () => {
    expect(sanitizeInternalRefs("")).toBe("");
  });

  it("never throws on non-string input (defensive)", () => {
    // A raw content-block array used to crash the pipeline via .replace.
    expect(() => sanitizeInternalRefs([{ text: "x" }] as never)).not.toThrow();
    expect(sanitizeInternalRefs([{ text: "x" }] as never)).toBe("");
    expect(sanitizeInternalRefs(null as never)).toBe("");
    expect(sanitizeInternalRefs(undefined as never)).toBe("");
  });

  it("collapses whitespace and dangling punctuation left by removals", () => {
    const out = sanitizeInternalRefs("结论：A。\n\n\n保存在 `memory/x.md`。\n\n下一步：B。");
    expect(out).not.toContain("memory");
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toContain("结论：A。");
    expect(out).toContain("下一步：B。");
    // The sentence that was nothing but a path leaves no dangling "。" line.
    expect(out).not.toMatch(/(^|\n)。(\n|$)/);
  });
});
