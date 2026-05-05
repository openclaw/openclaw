#!/usr/bin/env node
// Real-behavior repro for per-agent voice-call routing (PR #77763).
//
// Exercises the patched code paths via live `node` execution:
//   - extensions/voice-call/src/manager.ts (CallManager)
//   - extensions/voice-call/src/manager/outbound.ts (initiateCall)
//   - extensions/voice-call/src/manager/store.ts (JSONL persistence)
//   - extensions/voice-call/src/util/resolve-call-agent-id.ts (helper)
//   - extensions/voice-call/src/config.ts (VoiceCallConfigSchema)
//
// The Twilio provider is stubbed with a hand-written object that conforms to
// the VoiceCallProvider interface and returns realistic startCall results.
// Everything else (manager, JSONL store, helper, RPC payload construction)
// runs live source code.
//
// Run with:
//   node --import tsx scripts/proofs/per-agent-voice-call-routing.mjs
//
// Exit code 0 on success.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Live imports of the actual extension TS sources (loaded via tsx).
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const { CallManager } = await import(path.join(repoRoot, "extensions/voice-call/src/manager.ts"));
const { VoiceCallConfigSchema } = await import(
  path.join(repoRoot, "extensions/voice-call/src/config.ts")
);
const { resolveCallAgentId } = await import(
  path.join(repoRoot, "extensions/voice-call/src/util/resolve-call-agent-id.ts")
);
const { flushPendingCallRecordWritesForTest } = await import(
  path.join(repoRoot, "extensions/voice-call/src/manager/store.ts")
);

// Hand-written provider stub conforming to VoiceCallProvider. No mock library.
function createTwilioProviderStub() {
  let counter = 0;
  return {
    name: "twilio",
    verifyWebhook() {
      return { ok: true };
    },
    parseWebhookEvent() {
      return { events: [], statusCode: 200 };
    },
    async initiateCall(input) {
      counter += 1;
      return {
        providerCallId: `CA${String(counter).padStart(8, "0")}realstub`,
        status: "initiated",
      };
    },
    async hangupCall() {},
    async playTts() {},
    async startListening() {},
    async stopListening() {},
    async getCallStatus() {
      return { status: "in-progress", isTerminal: false };
    },
    isConversationStreamConnectEnabled() {
      return false;
    },
  };
}

function makeStorePath() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-call-proof-"));
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  const config = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "twilio",
    fromNumber: "+15550000000",
    maxConcurrentCalls: 4,
    // Plugin-default agentId — what the legacy code path collapses to.
    agentId: "main",
  });

  const storePath = makeStorePath();
  const provider = createTwilioProviderStub();
  const manager = new CallManager(config, storePath);
  await manager.initialize(provider, "https://example.invalid/voice/webhook");

  const dispatches = [
    {
      label: "google_meet.join (Slack user 1)",
      to: "+18005551111",
      opts: { agentId: "slack-u123", mode: "conversation" },
    },
    {
      label: "voice_call.initiate (Slack user 2)",
      to: "+18005552222",
      opts: { agentId: "slack-u456", mode: "conversation" },
    },
  ];

  const results = [];
  for (const d of dispatches) {
    const r = await manager.initiateCall(d.to, undefined, d.opts);
    if (!r.success) {
      console.error(`initiateCall failed: ${r.error}`);
      process.exit(1);
    }
    const call = manager.getCall(r.callId);
    results.push({ dispatch: d, callId: r.callId, call });
  }

  // effectiveConfig in production is the per-call resolution from
  // resolveVoiceCallEffectiveConfig (DID-route + base merge). For this proof
  // the base config carries agentId="main", which is precisely the legacy
  // collapse point — both calls would have resolved to "main" before the fix.
  const effectiveConfig = { agentId: config.agentId };

  console.log("=== AFTER FIX (resolveCallAgentId reads CallRecord.agentId first) ===");
  console.log(
    pad("dispatch", 36),
    pad("callId", 38),
    pad("CallRecord.agentId", 14),
    pad("resolveCallAgentId(call, cfg)", 30),
  );
  for (const r of results) {
    console.log(
      pad(r.dispatch.label, 36),
      pad(r.callId, 38),
      pad(r.call.agentId ?? "(unset)", 14),
      pad(resolveCallAgentId(r.call, effectiveConfig), 30),
    );
  }

  console.log("");
  console.log('=== LEGACY (pre-patch: effectiveConfig.agentId ?? "main") ===');
  console.log(pad("dispatch", 36), pad("callId", 38), pad("legacy resolution", 30));
  for (const r of results) {
    const legacy = effectiveConfig.agentId ?? "main";
    console.log(pad(r.dispatch.label, 36), pad(r.callId, 38), pad(legacy, 30));
  }

  console.log("");
  // CallManager persists records via a fire-and-forget async append; flush so
  // the JSONL on disk is fully materialized before we read it back.
  await flushPendingCallRecordWritesForTest();

  console.log("=== JSONL store inspection (calls.jsonl on disk) ===");
  const jsonlPath = path.join(storePath, "calls.jsonl");
  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const obj = JSON.parse(line);
    console.log(
      `  callId=${obj.callId} state=${obj.state} agentId=${obj.agentId ?? "(unset)"} to=${obj.to}`,
    );
  }

  console.log("");
  console.log("=== Verification ===");
  const distinctAfter = new Set(results.map((r) => resolveCallAgentId(r.call, effectiveConfig)));
  const distinctLegacy = new Set(results.map(() => effectiveConfig.agentId ?? "main"));
  console.log(
    `  AFTER FIX  distinct agents resolved: ${distinctAfter.size} (${[...distinctAfter].join(", ")})`,
  );
  console.log(
    `  LEGACY     distinct agents resolved: ${distinctLegacy.size} (${[...distinctLegacy].join(", ")})`,
  );

  if (distinctAfter.size !== 2) {
    console.error("FAIL: post-patch resolution did not yield two distinct agents.");
    process.exit(1);
  }
  if (distinctLegacy.size !== 1) {
    console.error("FAIL: legacy resolution did not collapse to a single agent.");
    process.exit(1);
  }
  console.log("  OK: per-call agent identity is preserved end-to-end.");

  // Best effort cleanup of tmpdir.
  try {
    fs.rmSync(storePath, { recursive: true, force: true });
  } catch {}
}

main().catch((err) => {
  console.error("UNEXPECTED ERROR:", err && err.stack ? err.stack : err);
  process.exit(1);
});
