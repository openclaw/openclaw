import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  listSignalAliasDirectoryEntries,
  resolveSignalDeliveredConversationKey,
  resolveSignalTarget,
} from "./aliases.js";

const group = "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=";
function signalConfig(aliases: Record<string, string>): OpenClawConfig {
  return { channels: { signal: { aliases } } };
}

it("rejects recursive aliases before delivery", () => {
  const cfg = signalConfig({ home: "signal:me", me: "home" });
  expect(() => resolveSignalTarget({ cfg, input: "home" })).toThrow(
    'Signal alias "home" resolves recursively through "home".',
  );
  expect(resolveSignalDeliveredConversationKey({ cfg, to: "signal:home" })).toBe("home");
});

it("resolves own prototype-shaped aliases without inheriting prototype keys", () => {
  const cfg = signalConfig({
    constructor: "+15551234567",
    toString: group,
  });

  expect(["constructor", "toString"].map((input) => resolveSignalTarget({ cfg, input }))).toEqual([
    { kind: "user", to: "+15551234567", alias: "constructor", source: "alias" },
    { kind: "group", to: group, alias: "tostring", source: "alias" },
  ]);

  const ordinaryCfg = signalConfig({ me: "+15551234567" });
  expect(resolveSignalTarget({ cfg: ordinaryCfg, input: "constructor" })).toBeNull();
});

it("resolves aliases and raw targets through the same canonical parser", () => {
  const cfg = signalConfig({
    "cafe\u0301": "uuid:123E4567-E89B-12D3-A456-426614174000",
    "+15551230000": "+15559990000",
  });
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  expect(
    ["signal:cafe\u0301", `uuid:${uuid.toUpperCase()}`, "+15551230000"].map((input) =>
      resolveSignalTarget({ cfg, input }),
    ),
  ).toEqual([
    { kind: "user", to: uuid, source: "alias", alias: "cafe\u0301" },
    { kind: "user", to: uuid, source: "raw" },
    { kind: "user", to: "+15551230000", source: "raw" },
  ]);
  expect(resolveSignalTarget({ cfg, input: "signal:café" })).toBeNull();
});

describe("listSignalAliasDirectoryEntries", () => {
  it("lists alias-backed peers and groups with alias display names", () => {
    const cfg = signalConfig({ "cafe\u0301": "+15551234567", ops: group });

    const user = [{ kind: "user", id: "+15551234567", name: "cafe\u0301" }];
    expect([
      listSignalAliasDirectoryEntries({ cfg, kind: "user", query: "CAFÉ" }),
      listSignalAliasDirectoryEntries({ cfg, kind: "user", query: "1555" }),
      listSignalAliasDirectoryEntries({ cfg, kind: "group" }),
    ]).toEqual([user, user, [{ kind: "group", id: group, name: "ops" }]]);
  });

  it("does not let fuzzy peer matches shadow exact group aliases", () => {
    const cfg = signalConfig({ ops: group, "ops-dm": "+15551234567" });

    expect(listSignalAliasDirectoryEntries({ cfg, kind: "user", query: "ops" })).toEqual([]);
    expect(listSignalAliasDirectoryEntries({ cfg, kind: "group", query: "ops" })).toEqual([
      { kind: "group", id: group, name: "ops" },
    ]);
  });

  it("fails invalid exact aliases instead of falling through to fuzzy matches", () => {
    const cfg = signalConfig({ ops: "not-a-signal-target", "ops-dm": "+15551234567" });

    expect(() => listSignalAliasDirectoryEntries({ cfg, kind: "user", query: "ops" })).toThrow(
      'Signal alias "ops" must point to an E.164 number, uuid:<id>, username:<name>, or group:<id>.',
    );
    expect(resolveSignalDeliveredConversationKey({ cfg, to: "signal:ops" })).toBe("ops");
  });
});
