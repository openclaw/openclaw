import { describe, expect, it } from "vitest";
import { assertAllowedJinheeWrite, isAllowedJinheeWrite } from "./jinhee-db-write-guard.js";

describe("Jinhee DB write guard", () => {
  it("allows INSERT INTO conversation_logs", () => {
    expect(isAllowedJinheeWrite("INSERT INTO conversation_logs (content) VALUES ('hi')")).toBe(
      true,
    );
  });

  it("allows lowercase insert into conversation_logs", () => {
    expect(isAllowedJinheeWrite("insert into conversation_logs (content) values ('hi')")).toBe(
      true,
    );
  });

  it("allows leading whitespace before INSERT INTO conversation_logs", () => {
    expect(isAllowedJinheeWrite("  INSERT INTO conversation_logs (content) VALUES ('hi')")).toBe(
      true,
    );
  });

  it("denies SELECT from conversation_logs", () => {
    expect(isAllowedJinheeWrite("SELECT * FROM conversation_logs")).toBe(false);
  });

  it("denies DELETE from conversation_logs", () => {
    expect(isAllowedJinheeWrite("DELETE FROM conversation_logs")).toBe(false);
  });

  it("denies UPDATE conversation_logs", () => {
    expect(isAllowedJinheeWrite("UPDATE conversation_logs SET content = 'x'")).toBe(false);
  });

  it("denies ALTER TABLE conversation_logs", () => {
    expect(isAllowedJinheeWrite("ALTER TABLE conversation_logs ADD COLUMN extra TEXT")).toBe(false);
  });

  it("denies DROP TABLE conversation_logs", () => {
    expect(isAllowedJinheeWrite("DROP TABLE conversation_logs")).toBe(false);
  });

  it("denies CREATE TABLE", () => {
    expect(isAllowedJinheeWrite("CREATE TABLE conversation_logs (content TEXT)")).toBe(false);
  });

  it("denies VACUUM", () => {
    expect(isAllowedJinheeWrite("VACUUM")).toBe(false);
  });

  it("denies INSERT INTO canonical_memories", () => {
    expect(isAllowedJinheeWrite("INSERT INTO canonical_memories (content) VALUES ('hi')")).toBe(
      false,
    );
  });

  it("denies multiple statements", () => {
    expect(
      isAllowedJinheeWrite("SELECT 1; INSERT INTO conversation_logs (content) VALUES ('hi')"),
    ).toBe(false);
  });

  it("throws from assertAllowedJinheeWrite when denied", () => {
    expect(() => assertAllowedJinheeWrite("DELETE FROM conversation_logs")).toThrow(
      "Jinhee DB write denied by guard",
    );
  });
});
