// Whatsapp tests cover the per-turn monitor config snapshot used by durable final delivery.
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveWebMonitorConfigSnapshot } from "./monitor-config-snapshot.js";

type SnapshotConfig = Parameters<typeof resolveWebMonitorConfigSnapshot>[0]["cfg"];

describe("resolveWebMonitorConfigSnapshot", () => {
  it("keeps an unchanged single-account channel section deep-equal to the raw config", () => {
    const cfg = {
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "pairing",
          allowFrom: ["+15550000001"],
          groupAllowFrom: ["+15550000001"],
          groupPolicy: "allowlist",
          mediaMaxMb: 50,
        },
      },
    } as unknown as SnapshotConfig;

    const { cfg: snapshot } = resolveWebMonitorConfigSnapshot({ cfg, accountId: "default" });

    // Durable final delivery compares exactly these two objects before a registry handoff.
    expect(Object.keys(snapshot.channels?.whatsapp ?? {}).toSorted()).toEqual(
      Object.keys(cfg.channels?.whatsapp ?? {}).toSorted(),
    );
    expect(isDeepStrictEqual(snapshot.channels?.whatsapp, cfg.channels?.whatsapp)).toBe(true);
  });

  it("still pins account-resolved values that differ from the root section", () => {
    const cfg = {
      channels: {
        whatsapp: {
          enabled: true,
          textChunkLimit: 4000,
          accounts: { work: { textChunkLimit: 1200 } },
        },
      },
    } as unknown as SnapshotConfig;

    const { cfg: snapshot, account } = resolveWebMonitorConfigSnapshot({ cfg, accountId: "work" });

    expect(account.textChunkLimit).toBe(1200);
    expect(snapshot.channels?.whatsapp?.textChunkLimit).toBe(1200);
  });

  it("keeps an explicit raw key even when the account resolves it to undefined", () => {
    const cfg = {
      channels: { whatsapp: { enabled: true, responsePrefix: undefined } },
    } as unknown as SnapshotConfig;

    const { cfg: snapshot } = resolveWebMonitorConfigSnapshot({ cfg, accountId: "default" });

    expect(Object.hasOwn(snapshot.channels?.whatsapp ?? {}, "responsePrefix")).toBe(true);
  });
});
