import { authenticate } from "mailauth";
import { simpleParser } from "mailparser";
import { describe, expect, it, vi } from "vitest";
import { resolveImapConfig } from "./config.js";
import { createImapAuthResult } from "./imap-test-support.js";
import { evaluateImapSender } from "./sender-gate.js";

function account(overrides: Record<string, unknown> = {}) {
  return resolveImapConfig({
    accounts: {
      inbox: {
        host: "imap.example.com",
        user: "reader@example.com",
        password: "test-password",
        agentId: "mail_reader",
        allowedSenders: ["trusted@example.com"],
        ...overrides,
      },
    },
  }).accounts.inbox!;
}

async function message(headers: string[]) {
  const raw = Buffer.from([...headers, "", "Hello from a trusted sender"].join("\r\n"));
  return { raw, mail: await simpleParser(raw), internalDate: new Date() };
}

describe("IMAP sender admission", () => {
  it.each([
    ["trusted@EXAMPLE.com", ["trusted@example.COM"], true],
    ["person@example.com", ["@EXAMPLE.com"], true],
    ["Trusted@example.com", ["trusted@example.com"], false],
  ])("matches sender %s against the actual addr-spec", async (sender, entries, accepted) => {
    const mail = await message([`From: ${sender}`, "To: reader+secret-token@example.com"]);
    const authenticator = vi.fn(async () => createImapAuthResult("pass"));
    const verdict = await evaluateImapSender({
      ...mail,
      account: account({
        allowedSenders: entries,
        addressTokens: [{ token: "secret-token", senders: [sender] }],
      }),
      authenticator,
    });
    expect(verdict.accepted).toBe(accepted);
    if (!accepted) {
      expect(verdict.reason).toBe("sender-not-allowed");
    }
    expect(authenticator).not.toHaveBeenCalled();
    expect(verdict).not.toHaveProperty("strength");
  });

  it("rejects a spoofed display name and ignores Reply-To", async () => {
    const mail = await message([
      'From: "trusted@example.com" <trusted@evil.example>',
      "Reply-To: trusted@example.com",
      "To: reader@example.com",
    ]);
    const authenticator = vi.fn(async () => createImapAuthResult("pass"));
    await expect(
      evaluateImapSender({ ...mail, account: account(), authenticator }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "sender-not-allowed",
    });
    expect(authenticator).not.toHaveBeenCalled();
  });

  it("rejects duplicate From headers before authentication", async () => {
    const mail = await message(["From: attacker@evil.example", "From: trusted@example.com"]);
    const authenticator = vi.fn(async () => createImapAuthResult("pass"));
    const verdict = await evaluateImapSender({ ...mail, account: account(), authenticator });
    expect(authenticator).not.toHaveBeenCalled();
    expect(verdict).toStrictEqual({
      accepted: false,
      reason: "invalid-from",
      transient: false,
    });
  });

  it("rejects stale mail before authentication even at the weakest floor", async () => {
    const mail = await message(["From: trusted@example.com"]);
    const authenticator = vi.fn(async () => createImapAuthResult("pass"));
    const verdict = await evaluateImapSender({
      ...mail,
      internalDate: new Date(Date.now() - 72 * 60 * 60 * 1_000),
      account: account({ senderAuth: { min: "mutable" } }),
      authenticator,
    });
    expect(authenticator).not.toHaveBeenCalled();
    expect(verdict).toStrictEqual({
      accepted: false,
      sender: "trusted@example.com",
      reason: "message-too-old",
      transient: false,
    });
  });

  it.each(["temperror", "none"] as const)(
    "never dispatches on DMARC %s at the default verified threshold",
    async (result) => {
      const mail = await message([
        "From: trusted@example.com",
        "To: reader+wrong-token@example.com",
      ]);
      const authentication = await authenticate(mail.raw, {
        disableArc: true,
        disableBimi: true,
        resolver: async () => {
          if (result === "temperror") {
            throw new Error("fixture DNS timeout");
          }
          return [];
        },
      });
      expect(authentication.dmarc).toMatchObject({ status: { result } });
      expect(authentication.dmarc).not.toHaveProperty("alignment");
      const configured = account({
        addressTokens: [{ token: "expected-token", senders: ["trusted@example.com"] }],
      });
      await expect(
        evaluateImapSender({
          ...mail,
          account: configured,
          authenticator: async () => authentication,
        }),
      ).resolves.toMatchObject({
        accepted: false,
        strength: "unverified",
        reason: result === "temperror" ? "authentication-temperror" : `dmarc-${result}`,
        transient: result === "temperror",
      });
    },
  );

  it.each(["pass", "fail"] as const)(
    "rejects unsigned body bytes even with DMARC %s",
    async (dmarc) => {
      const result = createImapAuthResult(dmarc);
      if (result.dmarc) {
        result.dmarc.alignment.dkim.underSized = 32;
      }
      const mail = await message(["From: trusted@example.com", "To: reader@example.com"]);
      const authenticator = vi.fn(async () => result);
      await expect(
        evaluateImapSender({ ...mail, account: account(), authenticator }),
      ).resolves.toMatchObject({ accepted: false, reason: "dkim-unsigned-body" });
    },
  );

  it("admits verified and unproven mail at an explicit unverified floor", async () => {
    const mail = await message(["From: trusted@example.com"]);
    const configured = account({ senderAuth: { min: "unverified" } });
    for (const result of ["pass", "none", "temperror"] as const) {
      await expect(
        evaluateImapSender({
          ...mail,
          account: configured,
          authenticator: async () => createImapAuthResult(result),
        }),
      ).resolves.toMatchObject({
        accepted: true,
        strength: result === "pass" ? "verified" : "unverified",
      });
    }
  });

  it("rejects untrusted Authentication-Results authorities", async () => {
    const configured = account({
      senderAuth: {
        min: "asserted",
        trustedAuthservIds: ["mx.example.com"],
        acceptTrustedAuthservId: true,
      },
    });
    const authenticator = vi.fn(async () => createImapAuthResult("none"));
    const untrusted = await message([
      "From: trusted@example.com",
      "Authentication-Results: attacker.example; dmarc=pass",
    ]);
    await expect(
      evaluateImapSender({ ...untrusted, account: configured, authenticator }),
    ).resolves.toMatchObject({
      accepted: false,
      strength: "unverified",
      reason: "unverified-authentication",
    });
  });

  it("admits stale mail with a sender-bound token without evaluating authentication", async () => {
    const configured = account({
      addressTokens: [{ token: "secret-token", senders: ["trusted@example.com"] }],
    });
    const accepted = await message([
      "From: trusted@example.com",
      "To: reader+secret-token@example.com",
    ]);
    const authenticator = vi.fn(async () => createImapAuthResult("none"));
    const verdict = await evaluateImapSender({
      ...accepted,
      internalDate: new Date(Date.now() - 72 * 60 * 60 * 1_000),
      account: configured,
      authenticator,
    });
    expect(authenticator).not.toHaveBeenCalled();
    expect(verdict).toStrictEqual({
      accepted: true,
      sender: "trusted@example.com",
      reason: "token",
    });
    const rejected = await message([
      "From: attacker@evil.example",
      "To: reader+secret-token@example.com",
    ]);
    await expect(
      evaluateImapSender({
        ...rejected,
        account: account({
          allowedSenders: ["@evil.example"],
          addressTokens: configured.addressTokens,
        }),
        authenticator,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      strength: "unverified",
      reason: "dmarc-none",
    });
    expect(authenticator).toHaveBeenCalledTimes(1);
  });

  it("uses only an explicitly trusted Authentication-Results header when DNS verification fails", async () => {
    const configured = account({
      senderAuth: {
        min: "asserted",
        trustedAuthservIds: ["mx.example.com"],
        acceptTrustedAuthservId: true,
      },
    });
    const parsed = await message([
      "From: trusted@example.com",
      "Authentication-Results: attacker.example; dmarc=pass",
      "Authentication-Results: mx.example.com; dmarc=pass header.from=example.com",
    ]);
    const authenticator = vi.fn(async () => {
      throw new Error("DNS timeout");
    });
    await expect(
      evaluateImapSender({ ...parsed, account: configured, authenticator }),
    ).resolves.toMatchObject({
      accepted: true,
      strength: "asserted",
      reason: "trusted-authserv-dmarc-pass",
    });
  });

  it("keeps authenticator exceptions retryable without claiming a mutable identifier", async () => {
    const mail = await message(["From: trusted@example.com"]);
    await expect(
      evaluateImapSender({
        ...mail,
        account: account({ senderAuth: { min: "unverified" } }),
        authenticator: async () => {
          throw new Error("DNS timeout");
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      strength: "unverified",
      reason: "authentication-temperror",
      transient: true,
    });
  });
});
