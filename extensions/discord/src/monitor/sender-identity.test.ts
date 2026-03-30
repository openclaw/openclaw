import { describe, expect, it } from "vitest";
import {
  resolveDiscordSenderIdentity,
  resolveDiscordTrustedPrincipalFromUserId,
} from "./sender-identity.js";

describe("resolveDiscordTrustedPrincipalFromUserId", () => {
  it("resolves canonical principal through identity links", () => {
    expect(
      resolveDiscordTrustedPrincipalFromUserId({
        userId: " 123456789 ",
        identityLinks: {
          alice: ["discord:123456789"],
        },
      }),
    ).toBe("alice");
  });

  it("keeps unmapped user ids unresolved", () => {
    expect(resolveDiscordTrustedPrincipalFromUserId({ userId: "123456789" })).toBeUndefined();
  });

  it("keeps malformed user ids unresolved", () => {
    expect(resolveDiscordTrustedPrincipalFromUserId({ userId: "alice" })).toBeUndefined();
    expect(resolveDiscordTrustedPrincipalFromUserId({ userId: "" })).toBeUndefined();
    expect(resolveDiscordTrustedPrincipalFromUserId({ userId: undefined })).toBeUndefined();
  });
});

describe("resolveDiscordSenderIdentity", () => {
  it("resolves trusted principal through identity links for regular users", () => {
    const sender = resolveDiscordSenderIdentity({
      author: {
        id: "111222333",
        username: "alice",
        globalName: "Alice",
      } as never,
      member: { nickname: "Display Name" },
      pluralkitInfo: null,
      identityLinks: {
        alice: ["discord:111222333"],
      },
    });

    expect(sender.id).toBe("111222333");
    expect(sender.trustedPrincipal).toBe("alice");
  });

  it("resolves trusted principal through identity links for pluralkit messages", () => {
    const sender = resolveDiscordSenderIdentity({
      author: {
        id: "444555666",
        username: "relay-bot",
      } as never,
      pluralkitInfo: {
        member: {
          id: "pk-member-1",
          display_name: "Proxy Name",
          name: "proxy",
        },
        system: {
          id: "pk-system-1",
          name: "System Name",
        },
      } as never,
      identityLinks: {
        system_owner: ["discord:444555666"],
      },
    });

    expect(sender.id).toBe("pk-member-1");
    expect(sender.trustedPrincipal).toBe("system_owner");
  });
});
