import { describe, expect, it } from "vitest";
import { parseMessage } from "./message-handler.js";

const buf = (obj: unknown): Buffer => Buffer.from(JSON.stringify(obj), "utf-8");

describe("parseMessage", () => {
  it("returns null for non-JSON input", () => {
    expect(parseMessage(Buffer.from("not json", "utf-8"))).toBeNull();
  });

  it("parses the flat format without a template_id (ordinary chat)", () => {
    const msg = parseMessage(buf({ id: 5, message: "hello", user_id: 42, session_id: "s1" }));
    expect(msg).not.toBeNull();
    expect(msg?.historyId).toBe(5);
    expect(msg?.message).toBe("hello");
    expect(msg?.userId).toBe("42");
    expect(msg?.templateId).toBeUndefined();
  });

  it("parses a numeric template_id in the flat format", () => {
    const msg = parseMessage(buf({ id: 5, message: "周报", user_id: 42, template_id: 7 }));
    expect(msg?.templateId).toBe(7);
  });

  it("coerces a numeric-string template_id (PHP/JSON producers vary)", () => {
    const msg = parseMessage(buf({ id: 5, message: "周报", user_id: 42, template_id: "7" }));
    expect(msg?.templateId).toBe(7);
  });

  it.each([0, -1, "", "abc", 3.5])("drops an invalid template_id %p", (value) => {
    const msg = parseMessage(buf({ id: 5, message: "x", user_id: 42, template_id: value }));
    expect(msg?.templateId).toBeUndefined();
  });

  it("reads template_id from the nested body (old format)", () => {
    const msg = parseMessage(
      buf({ id: 9, body: { message: "周报", user_id: 42, template_id: 12 } }),
    );
    expect(msg?.historyId).toBe(9);
    expect(msg?.message).toBe("周报");
    expect(msg?.templateId).toBe(12);
  });

  it("falls back to a top-level template_id when body omits it (old format)", () => {
    const msg = parseMessage(
      buf({ id: 9, template_id: 3, body: { message: "周报", user_id: 42 } }),
    );
    expect(msg?.templateId).toBe(3);
  });
});
