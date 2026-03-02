import { describe, expect, it } from "vitest";
import { zalouserPlugin } from "./channel.js";

describe("zalouser outbound chunker", () => {
  it("chunks without empty strings and respects limit", () => {
    const chunker = zalouserPlugin.outbound?.chunker;
    expect(chunker).toBeTypeOf("function");
    if (!chunker) {
      return;
    }

    const limit = 10;
    const chunks = chunker("hello world\nthis is a test", limit);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.every((c) => c.length <= limit)).toBe(true);
  });
});

describe("zalouser channel policies", () => {
  it("resolves group tool policy by explicit group id", () => {
    const resolveToolPolicy = zalouserPlugin.groups?.resolveToolPolicy;
    expect(resolveToolPolicy).toBeTypeOf("function");
    if (!resolveToolPolicy) {
      return;
    }
    const policy = resolveToolPolicy({
      cfg: {
        channels: {
          zalouser: {
            groups: {
              "123": { tools: { allow: ["search"] } },
            },
          },
        },
      },
      accountId: "default",
      groupId: "123",
      groupChannel: "123",
    });
    expect(policy).toEqual({ allow: ["search"] });
  });

  it("falls back to wildcard group policy", () => {
    const resolveToolPolicy = zalouserPlugin.groups?.resolveToolPolicy;
    expect(resolveToolPolicy).toBeTypeOf("function");
    if (!resolveToolPolicy) {
      return;
    }
    const policy = resolveToolPolicy({
      cfg: {
        channels: {
          zalouser: {
            groups: {
              "*": { tools: { deny: ["system.run"] } },
            },
          },
        },
      },
      accountId: "default",
      groupId: "missing",
      groupChannel: "missing",
    });
    expect(policy).toEqual({ deny: ["system.run"] });
  });
});
