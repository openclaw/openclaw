import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeEmailTarget,
  probeEmailAccount,
  sendMessageEmail,
  type ResolvedEmailAccount,
} from "./send.js";

const verifyMock = vi.hoisted(() => vi.fn(async () => true));
const sendMailMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "m-1" })));
const createTransportMock = vi.hoisted(() =>
  vi.fn(() => ({
    verify: verifyMock,
    sendMail: sendMailMock,
  })),
);

vi.mock("nodemailer", () => ({
  default: {
    createTransport: createTransportMock,
  },
}));

function makeAccount(overrides: Partial<ResolvedEmailAccount> = {}): ResolvedEmailAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: "user@example.com",
    smtpPass: "secret",
    from: "bot@example.com",
    subjectPrefix: "OpenClaw",
    config: {
      dmPolicy: "allowlist",
      allowFrom: [],
    },
    ...overrides,
  };
}

describe("email target normalization", () => {
  it("normalizes email: prefix", () => {
    expect(normalizeEmailTarget("email:User@Example.com")).toBe("user@example.com");
  });

  it("normalizes mailto: prefix", () => {
    expect(normalizeEmailTarget("mailto:User@Example.com")).toBe("user@example.com");
  });

  it("rejects invalid targets", () => {
    expect(() => normalizeEmailTarget("not-an-email")).toThrow("Invalid email target");
  });
});

describe("email send/probe", () => {
  beforeEach(() => {
    createTransportMock.mockClear();
    verifyMock.mockClear();
    sendMailMock.mockClear();
    sendMailMock.mockResolvedValue({ messageId: "m-1" });
    verifyMock.mockResolvedValue(true);
  });

  it("sends email through nodemailer", async () => {
    const account = makeAccount();
    const result = await sendMessageEmail({
      account,
      to: "email:dest@example.com",
      text: "hello",
    });
    expect(result.messageId).toBe("m-1");
    expect(result.to).toBe("dest@example.com");
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "bot@example.com",
        to: "dest@example.com",
        text: "hello",
      }),
    );
  });

  it("probes configured accounts", async () => {
    const account = makeAccount();
    const result = await probeEmailAccount(account);
    expect(result.ok).toBe(true);
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it("rejects send when account lacks required smtp config", async () => {
    const account = makeAccount({ configured: false, smtpHost: undefined });
    await expect(
      sendMessageEmail({
        account,
        to: "dest@example.com",
        text: "x",
      }),
    ).rejects.toThrow("not configured");
  });
});
