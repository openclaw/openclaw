import { describe, expect, it } from "vitest";
import { resolveTlonOutboundSession } from "./outbound-session.js";

describe("resolveTlonOutboundSession", () => {
  it("resolves direct and group targets with legacy parity", () => {
    const cases = [
      {
        target: "~sampel-palnet",
        expected: {
          peer: { kind: "direct", id: "~sampel-palnet" },
          from: "tlon:~sampel-palnet",
          to: "tlon:~sampel-palnet",
        },
      },
      {
        target: "dm:sampel-palnet",
        expected: {
          peer: { kind: "direct", id: "~sampel-palnet" },
          from: "tlon:~sampel-palnet",
          to: "tlon:~sampel-palnet",
        },
      },
      {
        target: "group:~host-ship/general",
        expected: {
          peer: { kind: "group", id: "chat/~host-ship/general" },
          from: "tlon:group:chat/~host-ship/general",
          to: "tlon:chat/~host-ship/general",
        },
      },
      {
        target: "chat/~host-ship/general",
        expected: {
          peer: { kind: "group", id: "chat/~host-ship/general" },
          from: "tlon:group:chat/~host-ship/general",
          to: "tlon:chat/~host-ship/general",
        },
      },
      {
        target: "~host-ship/general",
        expected: {
          peer: { kind: "group", id: "chat/~host-ship/general" },
          from: "tlon:group:chat/~host-ship/general",
          to: "tlon:chat/~host-ship/general",
        },
      },
      {
        target: "group:opaque-channel-id",
        expected: {
          peer: { kind: "group", id: "opaque-channel-id" },
          from: "tlon:group:opaque-channel-id",
          to: "tlon:opaque-channel-id",
        },
      },
      {
        target: "tlon:dm:~marzod",
        expected: {
          peer: { kind: "direct", id: "~marzod" },
          from: "tlon:~marzod",
          to: "tlon:~marzod",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const resolved = resolveTlonOutboundSession({
        cfg: {},
        target: testCase.target,
      });
      expect(resolved).not.toBeNull();
      expect(resolved?.peer).toEqual(testCase.expected.peer);
      expect(resolved?.from).toBe(testCase.expected.from);
      expect(resolved?.to).toBe(testCase.expected.to);
    }
  });

  it("returns null for blank target", () => {
    expect(resolveTlonOutboundSession({ cfg: {}, target: "   " })).toBeNull();
  });
});
