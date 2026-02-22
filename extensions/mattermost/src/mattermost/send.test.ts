import { describe, expect, it } from "vitest";
import { parseMattermostTarget } from "./send.js";

describe("parseMattermostTarget", () => {
  it("parses channel: prefix with valid ID as channel id", () => {
    const target = parseMattermostTarget("channel:dthcxgoxhifn3pwh65cut3ud3w");
    expect(target).toEqual({ kind: "channel", id: "dthcxgoxhifn3pwh65cut3ud3w" });
  });

  it("parses channel: prefix with non-ID as channel name", () => {
    const target = parseMattermostTarget("channel:abc123");
    expect(target).toEqual({ kind: "channel-name", name: "abc123" });
  });

  it("parses user: prefix as user id", () => {
    const target = parseMattermostTarget("user:usr456");
    expect(target).toEqual({ kind: "user", id: "usr456" });
  });

  it("parses mattermost: prefix as user id", () => {
    const target = parseMattermostTarget("mattermost:usr789");
    expect(target).toEqual({ kind: "user", id: "usr789" });
  });

  it("parses @ prefix as username", () => {
    const target = parseMattermostTarget("@alice");
    expect(target).toEqual({ kind: "user", username: "alice" });
  });

  it("parses # prefix as channel name", () => {
    const target = parseMattermostTarget("#off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("parses # prefix with spaces", () => {
    const target = parseMattermostTarget("  #general  ");
    expect(target).toEqual({ kind: "channel-name", name: "general" });
  });

  it("treats 26-char alphanumeric bare string as channel id", () => {
    const target = parseMattermostTarget("dthcxgoxhifn3pwh65cut3ud3w");
    expect(target).toEqual({ kind: "channel", id: "dthcxgoxhifn3pwh65cut3ud3w" });
  });

  it("treats non-ID bare string as channel name", () => {
    const target = parseMattermostTarget("off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("treats channel: with non-ID value as channel name", () => {
    const target = parseMattermostTarget("channel:off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("throws on empty string", () => {
    expect(() => parseMattermostTarget("")).toThrow("Recipient is required");
  });

  it("throws on empty # prefix", () => {
    expect(() => parseMattermostTarget("#")).toThrow("Channel name is required");
  });

  it("throws on empty @ prefix", () => {
    expect(() => parseMattermostTarget("@")).toThrow("Username is required");
  });

  it("parses channel:#name as channel name", () => {
    const target = parseMattermostTarget("channel:#off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("parses channel:#name with spaces", () => {
    const target = parseMattermostTarget("  channel: #general  ");
    expect(target).toEqual({ kind: "channel-name", name: "general" });
  });

  it("is case-insensitive for prefixes", () => {
    expect(parseMattermostTarget("CHANNEL:dthcxgoxhifn3pwh65cut3ud3w")).toEqual({
      kind: "channel",
      id: "dthcxgoxhifn3pwh65cut3ud3w",
    });
    expect(parseMattermostTarget("User:XYZ")).toEqual({ kind: "user", id: "XYZ" });
    expect(parseMattermostTarget("Mattermost:QRS")).toEqual({ kind: "user", id: "QRS" });
  });
});
