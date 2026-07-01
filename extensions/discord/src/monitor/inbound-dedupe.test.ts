// Discord tests cover inbound replay dedupe persistence across restart.
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimDiscordInboundReplay,
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
} from "./inbound-dedupe.js";

// Persistence is backed by the extensions Vitest setup, which isolates HOME /
// OPENCLAW_STATE_DIR per worker (test/setup.extensions.ts). The persistent
// dedupe resolves its SQLite path from that isolated env, so a second guard
// instance reading the same on-disk namespace == a process restart with an
// empty in-memory cache. resetPluginStateStoreForTests() closes the shared DB
// handle between tests (it does not clear rows).
afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("discord inbound replay guard persistence", () => {
  it("a committed key still dedupes on a fresh guard instance (survives restart)", async () => {
    const replayKey = "default:channel-1:message-1";

    // First guard instance claims + commits the key (message delivered).
    const guardA = createDiscordInboundReplayGuard();
    expect(await claimDiscordInboundReplay({ replayKey, replayGuard: guardA })).toBe(true);
    await commitDiscordInboundReplay({ replayKeys: [replayKey], replayGuard: guardA });

    // Second guard instance == process restart: fresh in-memory cache, same
    // persisted namespace. Discord's gateway resume can re-emit the message;
    // it must be recognized as a duplicate, not re-dispatched.
    const guardB = createDiscordInboundReplayGuard();
    expect(await claimDiscordInboundReplay({ replayKey, replayGuard: guardB })).toBe(false);
  });
});
