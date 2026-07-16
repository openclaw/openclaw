import { describe, expect, it } from "vitest";
import { isAgentMailSenderAllowed, parseSingleFromMailbox } from "./mailbox.js";

describe("AgentMail mailbox authorization", () => {
  it("parses the two AgentMail-documented From forms", () => {
    expect(parseSingleFromMailbox("Sender+tag@Example.COM")).toEqual({
      address: "sender+tag@example.com",
    });
    expect(parseSingleFromMailbox("Example Sender <Sender@Example.COM>")).toEqual({
      address: "sender@example.com",
      name: "Example Sender",
    });
    expect(parseSingleFromMailbox('"Sender, Example" <sender@example.com>')).toEqual({
      address: "sender@example.com",
      name: "Sender, Example",
    });
    expect(parseSingleFromMailbox('"Sender \\"Example\\"" <sender@example.com>')).toEqual({
      address: "sender@example.com",
      name: 'Sender "Example"',
    });
    expect(parseSingleFromMailbox("<sender@example.com>")).toEqual({
      address: "sender@example.com",
    });
    expect(parseSingleFromMailbox("Doe, John <john@example.com>")).toEqual({
      address: "john@example.com",
      name: "Doe, John",
    });
  });

  it.each([
    "",
    "one@example.com, two@example.com",
    "Team: one@example.com;",
    "sender@example.com\r\nBcc: victim@example.com",
    "Sender <sender@example.com",
    "Sender sender@example.com>",
    "Sender <sender@example.com><other@example.com>",
    "Sender <sender@example.com> trailing",
    "allowed@good.com <attacker@evil.com>",
    "Doe, John <john@example.com>, Other <other@example.com>",
    "sender@@example.com",
    "sender @example.com",
    ".sender@example.com",
    "sender.@example.com",
    "send..er@example.com",
    "sender@localhost",
    "sender@-example.com",
    "sender@example_domain.com",
    '"sender"@example.com',
    "séndér@example.com",
  ])("rejects unsupported or ambiguous From value %j", (value) => {
    expect(parseSingleFromMailbox(value)).toBeNull();
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
