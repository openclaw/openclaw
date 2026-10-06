import { generateKeyPairSync } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { authenticate, dkimSign, type AuthenticateResult } from "mailauth";
import { simpleParser } from "mailparser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveImapConfig } from "./config.js";
import { evaluateImapSender } from "./sender-gate.js";

// One ephemeral fixture key per suite; no network or persisted signing credential.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
const signingKey = privateKey.export({ type: "pkcs8", format: "pem" });
const dnsKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const sender = "trusted@team.example.com";

function configuredAccount() {
  return resolveImapConfig({
    accounts: {
      inbox: {
        host: "imap.example.com",
        user: "reader@example.com",
        password: "test-password",
        agentId: "mail_reader",
        allowedSenders: [sender],
      },
    },
  }).accounts.inbox!;
}

function dnsFixture(records: Record<string, string>) {
  const txt = vi.spyOn(Resolver.prototype, "resolveTxt").mockImplementation(async (domain) => {
    const record = records[domain];
    return record ? [[record]] : [];
  });
  const other = vi
    .spyOn(Resolver.prototype, "resolve")
    .mockRejectedValue(Object.assign(new Error("fixture NXDOMAIN"), { code: "ENOTFOUND" }));
  return { txt, other };
}

async function signedMessage(signingDomain: string, partial = false) {
  const input = Buffer.from(
    [
      "From: " + sender,
      "To: reader@example.com",
      "Subject: controlled authentication fixture",
      "Date: Mon, 05 Oct 2026 00:00:00 +0000",
      "",
      "Authenticated body.",
      "",
    ].join("\r\n"),
  );
  const signature = {
    signingDomain,
    selector: "fixture",
    privateKey: signingKey,
    ...(partial ? { maxBodyLength: 5 } : {}),
  };
  // Mailauth's declaration requires top-level signing fields, but its signer reads signatureData.
  const signed = await dkimSign(input, { ...signature, signatureData: [signature] });
  expect(signed.errors).toEqual([]);
  return Buffer.concat([Buffer.from(signed.signatures), input]);
}

async function admit(raw: Buffer) {
  let authentication: AuthenticateResult | undefined;
  const verdict = await evaluateImapSender({
    raw,
    mail: await simpleParser(raw),
    internalDate: new Date(),
    account: configuredAccount(),
    // Observe the real result without replacing authentication or its DNS adapter.
    authenticator: async (input, options) => {
      authentication = await authenticate(input, options);
      return authentication;
    },
  });
  return { verdict, authentication };
}

afterEach(() => vi.restoreAllMocks());

describe("IMAP admission with real mailauth", () => {
  it.each([
    ["team.example.com", false, true],
    ["example.com", true, true],
    ["example.com", false, false],
    ["unrelated.example", false, false],
  ] as const)(
    "uses DNS alignment for signer %s with parent policy %s",
    async (signer, parentPolicy, accepted) => {
      dnsFixture({
        ["fixture._domainkey." + signer]: "v=DKIM1; k=rsa; p=" + dnsKey,
        "_dmarc.team.example.com": "v=DMARC1; p=reject",
        ...(parentPolicy ? { "_dmarc.example.com": "v=DMARC1; p=reject" } : {}),
      });
      const result = await admit(await signedMessage(signer));
      expect(result.authentication?.dkim.results[0]?.status.result).toBe("pass");
      expect(result.authentication?.dmarc).toMatchObject({
        status: { result: accepted ? "pass" : "fail" },
      });
      expect(result.verdict).toMatchObject({
        accepted,
        strength: accepted ? "verified" : "unverified",
        reason: accepted ? "dmarc-pass" : "dmarc-fail",
      });
    },
  );

  it("rejects a passing signature that leaves body bytes unsigned", async () => {
    dnsFixture({
      "fixture._domainkey.team.example.com": "v=DKIM1; k=rsa; p=" + dnsKey,
      "_dmarc.team.example.com": "v=DMARC1; p=reject",
    });
    const result = await admit(await signedMessage("team.example.com", true));
    expect(result.authentication?.dmarc).toMatchObject({ status: { result: "pass" } });
    expect(result.verdict).toMatchObject({ accepted: false, reason: "dkim-unsigned-body" });
  });

  it("rejects a tampered body without treating a valid From address as proof", async () => {
    dnsFixture({
      "fixture._domainkey.team.example.com": "v=DKIM1; k=rsa; p=" + dnsKey,
      "_dmarc.team.example.com": "v=DMARC1; p=reject",
    });
    const raw = await signedMessage("team.example.com");
    const result = await admit(
      Buffer.from(raw.toString().replace("Authenticated body.", "Tampered body.")),
    );
    expect(result.verdict).toMatchObject({ accepted: false, strength: "unverified" });
  });

  it("preserves the CNAME query used to distinguish an existing subdomain", async () => {
    const dns = dnsFixture({
      "_dmarc.example.com": "v=DMARC1; p=reject; sp=quarantine; np=reject",
    });
    dns.other.mockImplementation(async (_domain, type) => {
      if (type === "CNAME") {
        return ["missing-target.example.net"];
      }
      throw Object.assign(new Error("fixture NXDOMAIN"), { code: "ENOTFOUND" });
    });
    const result = await admit(
      Buffer.from("From: " + sender + "\r\nTo: reader@example.com\r\n\r\nUnsigned body.\r\n"),
    );
    expect(dns.other).toHaveBeenCalledWith("team.example.com", "A");
    expect(dns.other).toHaveBeenCalledWith("team.example.com", "CNAME");
    expect(result.authentication?.dmarc).toMatchObject({
      policy: "quarantine",
      status: { result: "fail" },
    });
    expect(result.verdict).toMatchObject({ accepted: false, strength: "unverified" });
  });
});
