// Matrix tests cover allowlist plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  normalizeMatrixAllowList,
  resolveMatrixAllowListMatch,
  resolveMatrixContextSenderAllowed,
} from "./allowlist.js";

describe("resolveMatrixAllowListMatch", () => {
  it("matches full user IDs and prefixes", () => {
    const userId = "@Alice:Example.org";
    const direct = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList([userId]),
      userId,
    });
    expect(direct.allowed).toBe(true);
    expect(direct.matchSource).toBe("id");

    const prefixedMatrix = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList([`MATRIX:${userId}`]),
      userId,
    });
    expect(prefixedMatrix.allowed).toBe(true);
    expect(prefixedMatrix.matchSource).toBe("prefixed-id");

    const prefixedUser = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList([`USER:${userId}`]),
      userId,
    });
    expect(prefixedUser.allowed).toBe(true);
    expect(prefixedUser.matchSource).toBe("prefixed-user");
  });

  it("keeps complete Matrix user IDs case-sensitive", () => {
    const allowList = normalizeMatrixAllowList(["@\u212A:example.org"]);

    expect(resolveMatrixAllowListMatch({ allowList, userId: "@\u212A:example.org" }).allowed).toBe(
      true,
    );
    expect(resolveMatrixAllowListMatch({ allowList, userId: "@k:example.org" }).allowed).toBe(
      false,
    );
    expect(resolveMatrixAllowListMatch({ allowList, userId: "@\u212A:EXAMPLE.org" }).allowed).toBe(
      false,
    );
  });

  it("ignores display names and localparts", () => {
    const match = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["alice", "Alice"]),
      userId: "@alice:example.org",
    });
    expect(match.allowed).toBe(false);
  });

  it("matches wildcard", () => {
    const match = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["*"]),
      userId: "@alice:example.org",
    });
    expect(match.allowed).toBe(true);
    expect(match.matchSource).toBe("wildcard");
  });

  it("keeps access-group references symbolic and case-sensitive", () => {
    expect(normalizeMatrixAllowList(["accessGroup:Admins", " accessGroup:admins "])).toEqual([
      "accessGroup:Admins",
      "accessGroup:admins",
    ]);
    expect(
      resolveMatrixAllowListMatch({
        allowList: normalizeMatrixAllowList(["accessGroup:Admins"]),
        userId: "@alice:example.org",
      }).allowed,
    ).toBe(false);
  });
});

describe("resolveMatrixContextSenderAllowed", () => {
  const cfg = {
    accessGroups: {
      admins: { type: "message.senders", members: { matrix: ["@alice:example.org"] } },
    },
  } satisfies Pick<OpenClawConfig, "accessGroups">;

  it("rejects a stranger and a missing group", async () => {
    await expect(
      resolveMatrixContextSenderAllowed({
        cfg,
        allowList: ["accessGroup:admins"],
        accountId: "default",
        senderId: "@mallory:example.org",
      }),
    ).resolves.toBe(false);
    await expect(
      resolveMatrixContextSenderAllowed({
        cfg,
        allowList: ["accessGroup:missing"],
        accountId: "default",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("keeps literal allowlists and empty filters unchanged", async () => {
    await expect(
      resolveMatrixContextSenderAllowed({
        allowList: ["@alice:example.org"],
        accountId: "default",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
    await expect(
      resolveMatrixContextSenderAllowed({
        allowList: [],
        accountId: "default",
        senderId: "@mallory:example.org",
      }),
    ).resolves.toBe(true);
  });
});
