/**
 * Tests for Media Protocol Parser.
 */

import { describe, it, expect } from "vitest";
import { parseMediaProtocol, hasMediaTags } from "./media-protocol.js";

describe("hasMediaTags", () => {
  it("should return true for content with image tag", () => {
    expect(hasMediaTags('[DING:IMAGE path="/tmp/test.png"]')).toBe(true);
  });

  it("should return true for content with file tag", () => {
    expect(hasMediaTags('[DING:FILE path="/tmp/test.pdf" name="Report.pdf"]')).toBe(true);
  });

  it("should return true for content with video tag", () => {
    expect(hasMediaTags('[DING:VIDEO path="/tmp/test.mp4"]')).toBe(true);
  });

  it("should return true for content with audio tag", () => {
    expect(hasMediaTags('[DING:AUDIO path="/tmp/test.mp3"]')).toBe(true);
  });

  it("should return false for content without media tags", () => {
    expect(hasMediaTags("Hello, this is a regular message")).toBe(false);
  });

  it("should return false for malformed tags", () => {
    expect(hasMediaTags("[DING:IMAGE /tmp/test.png]")).toBe(false);
    expect(hasMediaTags("DING:IMAGE path=/tmp/test.png")).toBe(false);
  });
});

describe("parseMediaProtocol", () => {
  describe("single tags", () => {
    it("should parse single image tag", () => {
      const content = 'Here is an image:\n[DING:IMAGE path="/tmp/test.png"]';
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        type: "image",
        path: "/tmp/test.png",
        name: undefined,
      });
      expect(result.cleanedContent).toBe("Here is an image:");
    });

    it("should parse single file tag with name", () => {
      const content =
        'Report attached:\n[DING:FILE path="/tmp/report.pdf" name="Annual Report.pdf"]';
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        type: "file",
        path: "/tmp/report.pdf",
        name: "Annual Report.pdf",
      });
      expect(result.cleanedContent).toBe("Report attached:");
    });

    it("should parse file tag without name", () => {
      const content = '[DING:FILE path="/data/file.docx"]';
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        type: "file",
        path: "/data/file.docx",
        name: undefined,
      });
    });

    it("should parse video tag", () => {
      const content = '[DING:VIDEO path="/tmp/demo.mp4"]';
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        type: "video",
        path: "/tmp/demo.mp4",
        name: undefined,
      });
    });

    it("should parse audio tag", () => {
      const content = '[DING:AUDIO path="/tmp/voice.mp3"]';
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        type: "audio",
        path: "/tmp/voice.mp3",
        name: undefined,
      });
    });
  });

  describe("multiple tags", () => {
    it("should parse multiple tags of same type", () => {
      const content = `Here are the images:
[DING:IMAGE path="/tmp/img1.png"]
[DING:IMAGE path="/tmp/img2.png"]`;
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(2);
      expect(result.items[0].path).toBe("/tmp/img1.png");
      expect(result.items[1].path).toBe("/tmp/img2.png");
      expect(result.cleanedContent).toBe("Here are the images:");
    });

    it("should parse mixed media types", () => {
      const content = `Here is the report:
[DING:IMAGE path="/tmp/chart.png"]
[DING:FILE path="/tmp/report.pdf" name="Report.pdf"]
Let me know if you need more.`;
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toEqual({
        type: "image",
        path: "/tmp/chart.png",
        name: undefined,
      });
      expect(result.items[1]).toEqual({
        type: "file",
        path: "/tmp/report.pdf",
        name: "Report.pdf",
      });
      expect(result.cleanedContent).toBe("Here is the report:\n\nLet me know if you need more.");
    });
  });

  describe("path handling", () => {
    it("should handle file:// prefix", () => {
      const content = '[DING:IMAGE path="file:///tmp/test.png"]';
      const result = parseMediaProtocol(content);

      expect(result.items[0].path).toBe("/tmp/test.png");
    });

    it("should handle URL-encoded paths", () => {
      const content = '[DING:FILE path="/tmp/my%20report.pdf"]';
      const result = parseMediaProtocol(content);

      expect(result.items[0].path).toBe("/tmp/my report.pdf");
    });

    it("should handle Windows paths", () => {
      const content = '[DING:FILE path="C:\\Users\\test\\file.txt"]';
      const result = parseMediaProtocol(content);

      expect(result.items[0].path).toBe("C:\\Users\\test\\file.txt");
    });
  });

  describe("edge cases", () => {
    it("should handle content with no tags", () => {
      const content = "Just a regular message.";
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(0);
      expect(result.cleanedContent).toBe("Just a regular message.");
    });

    it("should handle empty content", () => {
      const result = parseMediaProtocol("");

      expect(result.items).toHaveLength(0);
      expect(result.cleanedContent).toBe("");
    });

    it("should handle only tags (no surrounding text)", () => {
      const content = '[DING:IMAGE path="/tmp/only.png"]';
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(1);
      expect(result.cleanedContent).toBe("");
    });

    it("should be case-insensitive for tag names", () => {
      const content = '[ding:image path="/tmp/test.png"]';
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].type).toBe("image");
    });

    it("should handle extra whitespace in tags", () => {
      const content = '[DING:IMAGE   path="/tmp/test.png"]';
      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].path).toBe("/tmp/test.png");
    });
  });

  describe("realistic scenarios", () => {
    it("should handle a full AI response with media", () => {
      const content = `我已经为您生成了图表:

[DING:IMAGE path="/tmp/sales_chart.png"]

同时，详细的数据报告也准备好了:

[DING:FILE path="/tmp/sales_report.xlsx" name="销售报告.xlsx"]

如果您需要其他格式的文件，请告诉我。`;

      const result = parseMediaProtocol(content);

      expect(result.items).toHaveLength(2);
      expect(result.items[0].type).toBe("image");
      expect(result.items[1].type).toBe("file");
      expect(result.items[1].name).toBe("销售报告.xlsx");
      expect(result.cleanedContent).toContain("我已经为您生成了图表");
      expect(result.cleanedContent).toContain("如果您需要其他格式的文件");
      expect(result.cleanedContent).not.toContain("DING:");
    });
  });
});
