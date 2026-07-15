import { describe, expect, it } from "vitest";
import { isAgentMailSenderAllowed, parseSingleFromMailbox } from "./mailbox.js";

describe("AgentMail mailbox authorization", () => {
  it("parses one display-name mailbox and normalizes its address", () => {
    expect(parseSingleFromMailbox("Example Sender <Sender@Example.COM>")).toEqual({
      address: "sender@example.com",
      name: "Example Sender",
    });
  });

  it("rejects ambiguous From lists and groups", () => {
    expect(parseSingleFromMailbox("one@example.com, two@example.com")).toBeNull();
    expect(parseSingleFromMailbox("Team: one@example.com;")).toBeNull();
  });

  it("denies empty allowlists and opens only through an explicit wildcard", () => {
    expect(
      isAgentMailSenderAllowed({
        policy: "allowlist",
        allowFrom: [],
        sender: "sender@example.com",
      }),
    ).toBe(false);
    expect(
      isAgentMailSenderAllowed({
        policy: "allowlist",
        allowFrom: ["SENDER@example.com"],
        sender: "sender@example.com",
      }),
    ).toBe(true);
    expect(
      isAgentMailSenderAllowed({ policy: "open", allowFrom: ["*"], sender: "any@example.com" }),
    ).toBe(true);
  });
});
