// Discord tests cover inbound replay dedupe persistence across restart.
import { installIsolatedPluginStateDirForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimDiscordInboundReplay,
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
} from "./inbound-dedupe.js";

// Per-test state dir: a second guard instance reading the same on-disk
// namespace == a process restart with an empty in-memory cache, and the
// committed keys cannot leak into other suites sharing the worker.
let stateDir: ReturnType<typeof installIsolatedPluginStateDirForTests>;

beforeEach(() => {
  stateDir = installIsolatedPluginStateDirForTests();
});

afterEach(() => {
  stateDir.restore();
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
