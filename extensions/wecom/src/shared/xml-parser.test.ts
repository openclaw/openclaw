import { describe, expect, test } from "vitest";
import {
  parseXml,
  extractMsgType,
  extractFromUser,
  extractContent,
  extractMediaId,
  extractMsgId,
  extractAgentId,
  extractFileName,
} from "./xml-parser.js";

describe("WeCom XML parser", () => {
  const textXml = `<xml>
    <ToUserName><![CDATA[ww1234567890]]></ToUserName>
    <FromUserName><![CDATA[user001]]></FromUserName>
    <MsgType><![CDATA[text]]></MsgType>
    <Content><![CDATA[Hello World]]></Content>
    <MsgId>12345678</MsgId>
    <AgentID>1000002</AgentID>
  </xml>`;

  test("parseXml returns a valid message object", () => {
    const msg = parseXml(textXml);
    expect(msg).toBeDefined();
    expect(msg.MsgType).toBe("text");
  });

  test("extractMsgType returns lowercase type", () => {
    const msg = parseXml(textXml);
    expect(extractMsgType(msg)).toBe("text");
  });

  test("extractFromUser returns sender", () => {
    const msg = parseXml(textXml);
    expect(extractFromUser(msg)).toBe("user001");
  });

  test("extractContent returns text content", () => {
    const msg = parseXml(textXml);
    expect(extractContent(msg)).toBe("Hello World");
  });

  test("extractMsgId returns message ID", () => {
    const msg = parseXml(textXml);
    expect(extractMsgId(msg)).toBe("12345678");
  });

  test("extractAgentId returns agent ID", () => {
    const msg = parseXml(textXml);
    const agentId = extractAgentId(msg);
    expect(agentId).toBeDefined();
    expect(String(agentId)).toBe("1000002");
  });

  const imageXml = `<xml>
    <ToUserName><![CDATA[ww1234567890]]></ToUserName>
    <FromUserName><![CDATA[user002]]></FromUserName>
    <MsgType><![CDATA[image]]></MsgType>
    <PicUrl><![CDATA[https://example.com/pic.jpg]]></PicUrl>
    <MediaId><![CDATA[media_id_123]]></MediaId>
    <MsgId>99999</MsgId>
  </xml>`;

  test("extractMediaId returns media ID from image message", () => {
    const msg = parseXml(imageXml);
    expect(extractMediaId(msg)).toBe("media_id_123");
  });

  test("extractContent formats image message", () => {
    const msg = parseXml(imageXml);
    const content = extractContent(msg);
    expect(content).toContain("[图片]");
    expect(content).toContain("https://example.com/pic.jpg");
  });

  const fileXml = `<xml>
    <ToUserName><![CDATA[ww1234567890]]></ToUserName>
    <FromUserName><![CDATA[user003]]></FromUserName>
    <MsgType><![CDATA[file]]></MsgType>
    <FileName><![CDATA[report.pdf]]></FileName>
    <MsgId>55555</MsgId>
  </xml>`;

  test("extractFileName returns filename from file message", () => {
    const msg = parseXml(fileXml);
    expect(extractFileName(msg)).toBe("report.pdf");
  });

  test("parseXml handles empty string gracefully", () => {
    // fast-xml-parser may return undefined or empty for invalid XML
    const msg = parseXml("");
    expect(msg).toBeDefined();
  });

  test("extractMsgType returns empty for missing MsgType", () => {
    const msg = parseXml("<xml><Content>test</Content></xml>");
    expect(extractMsgType(msg)).toBe("");
  });
});
