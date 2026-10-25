import { authenticate } from "mailauth";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveImapConfig } from "./config.js";
import { createImapAuthResult } from "./imap-test-support.js";
import { evaluateImapSender } from "./sender-gate.js";

vi.mock("mailauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mailauth")>();
  return { ...actual, authenticate: vi.fn(actual.authenticate) };
});

afterEach(() => vi.mocked(authenticate).mockReset());
beforeEach(() => vi.mocked(authenticate).mockResolvedValue(createImapAuthResult("pass")));

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

function evaluate(
  mail: Awaited<ReturnType<typeof message>>,
  overrides = {},
  internalDate = mail.internalDate,
) {
  return evaluateImapSender({ ...mail, internalDate, account: account(overrides) });
}

const trustedHeaders = {
  min: "asserted",
  trustedAuthservIds: ["mx.example.com"],
  acceptTrustedAuthservId: true,
};

describe("IMAP sender admission", () => {
  it.each([
    ["trusted@EXAMPLE.com", ["trusted@example.COM"], true],
    ["person@example.com", ["@EXAMPLE.com"], true],
    ["Trusted@example.com", ["trusted@example.com"], false],
  ])("matches sender %s against the actual addr-spec", async (sender, entries, accepted) => {
    const mail = await message([`From: ${sender}`, "To: reader+secret-token@example.com"]);
    const verdict = await evaluate(mail, {
      allowedSenders: entries,
      addressTokens: [{ token: "secret-token", senders: [sender] }],
    });
    expect(verdict.accepted).toBe(accepted);
    if (!accepted) {
      expect(verdict.reason).toBe("sender-not-allowed");
    }
    expect(authenticate).not.toHaveBeenCalled();
    expect(verdict).not.toHaveProperty("strength");
  });

  it.each([
    {
      name: "spoofed display name and Reply-To",
      headers: [
        'From: "trusted@example.com" <trusted@evil.example>',
        "Reply-To: trusted@example.com",
        "To: reader@example.com",
      ],
      expected: { sender: "trusted@evil.example", reason: "sender-not-allowed" },
    },
    {
      name: "duplicate From",
      headers: ["From: attacker@evil.example", "From: trusted@example.com"],
      expected: { reason: "invalid-from" },
    },
    {
      name: "stale mail even at the weakest floor",
      headers: ["From: trusted@example.com"],
      expected: { sender: "trusted@example.com", reason: "message-too-old" },
    },
  ])("rejects $name before authentication", async ({ headers, expected }) => {
    const mail = await message(headers);
    const date =
      expected.reason === "message-too-old"
        ? new Date(Date.now() - 72 * 60 * 60 * 1_000)
        : mail.internalDate;
    const overrides =
      expected.reason === "message-too-old" ? { senderAuth: { min: "mutable" } } : {};
    await expect(evaluate(mail, overrides, date)).resolves.toStrictEqual({
      accepted: false,
      transient: false,
      ...expected,
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it.each(["temperror", "none"] as const)(
    "never dispatches on DMARC %s at the default verified threshold",
    async (result) => {
      const mail = await message([
        "From: trusted@example.com",
        "To: reader+wrong-token@example.com",
      ]);
      const { authenticate: authenticateReal } =
        await vi.importActual<typeof import("mailauth")>("mailauth");
      const authentication = await authenticateReal(mail.raw, {
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
      vi.mocked(authenticate).mockResolvedValue(authentication);
      await expect(
        evaluate(mail, {
          addressTokens: [{ token: "expected-token", senders: ["trusted@example.com"] }],
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
      result.dmarc.alignment.dkim.underSized = 32;
      const mail = await message(["From: trusted@example.com", "To: reader@example.com"]);
      vi.mocked(authenticate).mockResolvedValue(result);
      await expect(evaluate(mail)).resolves.toMatchObject({
        accepted: false,
        reason: "dkim-unsigned-body",
      });
    },
  );

  it("admits verified and unproven mail at an explicit unverified floor", async () => {
    const mail = await message(["From: trusted@example.com"]);
    for (const result of ["pass", "none", "temperror"] as const) {
      vi.mocked(authenticate).mockResolvedValue(createImapAuthResult(result));
      await expect(evaluate(mail, { senderAuth: { min: "unverified" } })).resolves.toMatchObject({
        accepted: true,
        strength: result === "pass" ? "verified" : "unverified",
      });
    }
  });

  it.each([
    ["trusted header without opt-in", "mx.example.com", false, false],
    ["trusted header with opt-in", "mx.example.com", true, true],
    ["untrusted authority", "attacker.example", true, false],
  ] as const)("gates asserted admission: %s", async (_name, authority, optIn, accepted) => {
    vi.mocked(authenticate).mockResolvedValue(createImapAuthResult("none"));
    const mail = await message([
      "From: trusted@example.com",
      `Authentication-Results: ${authority}; dmarc=pass header.from=example.com`,
    ]);
    await expect(
      evaluate(mail, optIn ? { senderAuth: trustedHeaders } : {}),
    ).resolves.toMatchObject({
      accepted,
      strength: accepted ? "asserted" : "unverified",
      reason: accepted ? "trusted-authserv-dmarc-pass" : "unverified-authentication",
    });
  });

  it("admits stale mail with a sender-bound token without evaluating authentication", async () => {
    const addressTokens = [{ token: "secret-token", senders: ["trusted@example.com"] }];
    const accepted = await message([
      "From: trusted@example.com",
      "To: reader+secret-token@example.com",
    ]);
    vi.mocked(authenticate).mockResolvedValue(createImapAuthResult("none"));
    const verdict = await evaluate(
      accepted,
      { addressTokens },
      new Date(Date.now() - 72 * 60 * 60 * 1_000),
    );
    expect(authenticate).not.toHaveBeenCalled();
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
      evaluate(rejected, {
        allowedSenders: ["@evil.example"],
        addressTokens,
      }),
    ).resolves.toMatchObject({ accepted: false, strength: "unverified", reason: "dmarc-none" });
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("uses only an explicitly trusted Authentication-Results header when DNS verification fails", async () => {
    const parsed = await message([
      "From: trusted@example.com",
      "Authentication-Results: attacker.example; dmarc=pass",
      "Authentication-Results: mx.example.com; dmarc=pass header.from=example.com",
    ]);
    vi.mocked(authenticate).mockRejectedValue(new Error("DNS timeout"));
    await expect(evaluate(parsed, { senderAuth: trustedHeaders })).resolves.toMatchObject({
      accepted: true,
      strength: "asserted",
      reason: "trusted-authserv-dmarc-pass",
    });
  });

  it("keeps authenticator exceptions retryable without claiming a mutable identifier", async () => {
    const mail = await message(["From: trusted@example.com"]);
    vi.mocked(authenticate).mockRejectedValue(new Error("DNS timeout"));
    await expect(evaluate(mail, { senderAuth: { min: "unverified" } })).resolves.toMatchObject({
      accepted: false,
      strength: "unverified",
      reason: "authentication-temperror",
      transient: true,
    });
  });
});
