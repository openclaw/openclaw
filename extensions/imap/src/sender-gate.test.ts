import { generateKeyPairSync } from "node:crypto";
import { authenticate, dkimSign } from "mailauth";
import { simpleParser } from "mailparser";
import type { IdentifierAuthentication } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveImapConfig } from "./config.js";
import { createImapAuthResult } from "./imap-test-support.js";
import { renderImapPrompt } from "./prompt.js";
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

async function message(headers: string[], body = "Hello from a trusted sender") {
  const raw = Buffer.from([...headers, "", body].join("\r\n"));
  return { raw, mail: await simpleParser(raw), internalDate: new Date() };
}

describe("IMAP sender admission", () => {
  it.each([
    ["trusted@EXAMPLE.com", ["trusted@example.COM"], true],
    ["person@example.com", ["@EXAMPLE.com"], true],
    ["trusted@evil.example", ["trusted@example.com"], false],
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
      'From: "trusted@example.com" <attacker@evil.example>',
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

  it.each([
    ["From: trusted@example.com, attacker@evil.example"],
    ["From: attacker@evil.example", "From: trusted@example.com"],
  ])("rejects multi-From messages before authentication", async (...headers) => {
    const mail = await message(headers);
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

  it.each(["neutral", "temperror", "none"] as const)(
    "never dispatches on DMARC %s at the default verified threshold",
    async (result) => {
      const mail = await message([
        "From: trusted@example.com",
        "To: reader+wrong-token@example.com",
      ]);
      const authentication =
        result === "neutral"
          ? createImapAuthResult(result)
          : await authenticate(mail.raw, {
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
      if (result !== "neutral") {
        expect(authentication.dmarc).not.toHaveProperty("alignment");
      }
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

  it.each([
    ["mutable", true],
    ["unverified", true],
    ["asserted", false],
    ["verified", false],
  ] satisfies [IdentifierAuthentication, boolean][])(
    "admits verified mail and applies the %s floor to unproven mail",
    async (min, acceptsUnproven) => {
      const mail = await message(["From: trusted@example.com"]);
      const configured = account({ senderAuth: { min } });
      for (const result of ["pass", "none", "temperror"] as const) {
        await expect(
          evaluateImapSender({
            ...mail,
            account: configured,
            authenticator: async () => createImapAuthResult(result),
          }),
        ).resolves.toMatchObject({
          accepted: result === "pass" || acceptsUnproven,
          strength: result === "pass" ? "verified" : "unverified",
        });
      }
    },
  );

  it("accepts only configured Authentication-Results authorities", async () => {
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
    const trusted = await message([
      "From: trusted@example.com",
      "Authentication-Results: mx.example.com; dmarc=pass header.from=example.com",
    ]);
    await expect(
      evaluateImapSender({ ...trusted, account: configured, authenticator }),
    ).resolves.toMatchObject({
      accepted: true,
      strength: "asserted",
      reason: "trusted-authserv-dmarc-pass",
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

  it("caps rendered prompts and records truncation", async () => {
    const parsed = await message(["From: trusted@example.com", "Subject: Large"], "🙂".repeat(500));
    const prompt = renderImapPrompt(parsed.mail, { includeBody: true, maxBytes: 256 });
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(256);
    expect(prompt).toContain("[truncated:");
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

  it("keeps a nested DKIM key-lookup timeout retryable when DMARC resolves to fail", async () => {
    const mail = await message(["From: trusted@example.com", "To: reader@example.com"]);
    const authentication = createImapAuthResult("fail");
    authentication.dkim.results.push({
      signingDomain: "example.com",
      selector: "default",
      status: { result: "temperror", comment: "DNS failure: ETIMEOUT" },
      info: "dkim=temperror (DNS failure: ETIMEOUT) header.i=@example.com header.s=default",
    });
    await expect(
      evaluateImapSender({
        ...mail,
        account: account(),
        authenticator: async () => authentication,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      strength: "unverified",
      reason: "authentication-temperror",
      transient: true,
    });
  });

  it("retries a real DKIM key-lookup timeout that DMARC resolves to fail", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const unsigned = Buffer.from(
      [
        "From: trusted@example.com",
        "To: reader@example.com",
        "Subject: signed fixture",
        "Date: Wed, 16 Sep 2026 10:00:00 +0000",
        "",
        "Hello from a trusted sender",
      ].join("\r\n"),
    );
    // The declared options type requires the signature fields at the top level while
    // the signer emits signatures from signatureData, so provide both.
    const signed = await dkimSign(unsigned, {
      signingDomain: "example.com",
      selector: "default",
      privateKey: privateKeyPem,
      signatureData: [
        { signingDomain: "example.com", selector: "default", privateKey: privateKeyPem },
      ],
    });
    expect(signed.errors).toEqual([]);
    const raw = Buffer.concat([Buffer.from(signed.signatures), unsigned]);
    const authentication = await authenticate(raw, {
      disableArc: true,
      disableBimi: true,
      resolver: async (domain) => {
        if (domain === "default._domainkey.example.com") {
          throw Object.assign(new Error("queryTxt ETIMEOUT"), { code: "ETIMEOUT" });
        }
        return domain === "_dmarc.example.com" ? [["v=DMARC1; p=reject"]] : [];
      },
    });
    expect(authentication.dkim.results).toMatchObject([
      { signingDomain: "example.com", status: { result: "temperror" } },
    ]);
    expect(authentication.dmarc).toMatchObject({ status: { result: "fail" }, policy: "reject" });
    await expect(
      evaluateImapSender({
        raw,
        mail: await simpleParser(raw),
        internalDate: new Date(),
        account: account(),
        authenticator: async () => authentication,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      strength: "unverified",
      reason: "authentication-temperror",
      transient: true,
    });
  });

  it("does not retry a permanently failed signature", async () => {
    const mail = await message(["From: trusted@example.com", "To: reader@example.com"]);
    const authentication = createImapAuthResult("fail");
    authentication.dkim.results.push({
      signingDomain: "example.com",
      selector: "default",
      status: { result: "fail", comment: "bad signature" },
      info: "dkim=fail (bad signature) header.i=@example.com header.s=default",
    });
    await expect(
      evaluateImapSender({
        ...mail,
        account: account(),
        authenticator: async () => authentication,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      strength: "unverified",
      reason: "dmarc-fail",
      transient: false,
    });
  });
});
