// Real behavior proof for #95325: drives the production deriveSessionMetaPatch
// to verify stale per-channel origin fields are reset on a channel switch.
//
// Run: node --import tsx scripts/repro/issue-95325-channel-switch.mts
import { deriveSessionMetaPatch } from "../../src/config/sessions/metadata.ts";
import type { MsgContext } from "../../src/auto-reply/templating.ts";
import type { SessionEntry } from "../../src/config/sessions/types.ts";

function slackDmCtx(): MsgContext {
  return {
    Provider: "slack",
    OriginatingChannel: "slack",
    Surface: "slack",
    ChatType: "direct",
    From: "slack-user-id",
    NativeChannelId: "Dslackdm",
    NativeDirectUserId: "Uslackuser",
    AccountId: "slack-account",
  } as MsgContext;
}

function telegramDmCtx(): MsgContext {
  // Telegram DMs carry no nativeChannelId / nativeDirectUserId.
  return {
    Provider: "telegram",
    OriginatingChannel: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    From: "telegram-user-id",
    AccountId: "telegram-account",
  } as MsgContext;
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

let existing: SessionEntry | undefined = undefined;

// Turn 1: Slack DM seeds the shared session with Slack native identity.
const slackPatch = deriveSessionMetaPatch({
  ctx: slackDmCtx(),
  sessionKey: "dm:shared",
  existing,
});
existing = { ...(existing ?? ({} as SessionEntry)), ...(slackPatch ?? {}) } as SessionEntry;

if (existing.origin?.nativeChannelId !== "Dslackdm") {
  fail(`after Slack turn nativeChannelId should be Dslackdm, got ${existing.origin?.nativeChannelId}`);
}
console.log("PASS: Slack turn seeds origin.nativeChannelId = Dslackdm");

// Turn 2: Same user DMs on Telegram. Telegram supplies no nativeChannelId.
const tgPatch = deriveSessionMetaPatch({
  ctx: telegramDmCtx(),
  sessionKey: "dm:shared",
  existing,
});

const switchedOrigin = tgPatch?.origin;
console.log("Telegram-switch origin:", JSON.stringify(switchedOrigin));

if (switchedOrigin?.provider !== "telegram") {
  fail(`provider should switch to telegram, got ${switchedOrigin?.provider}`);
}
if (switchedOrigin?.nativeChannelId !== undefined) {
  fail(
    `nativeChannelId should be reset after switch, got stale ${switchedOrigin.nativeChannelId}`,
  );
}
if (switchedOrigin?.nativeDirectUserId !== undefined) {
  fail(
    `nativeDirectUserId should be reset after switch, got stale ${switchedOrigin.nativeDirectUserId}`,
  );
}
console.log("PASS: channel switch to telegram reset stale nativeChannelId / nativeDirectUserId");

// Turn 3: Switch back to Slack — new nativeChannelId is adopted.
const slackBackPatch = deriveSessionMetaPatch({
  ctx: slackDmCtx(),
  sessionKey: "dm:shared",
  existing: { ...(existing as SessionEntry), ...(tgPatch ?? {}) } as SessionEntry,
});
if (slackBackPatch?.origin?.nativeChannelId !== "Dslackdm") {
  fail(
    `nativeChannelId should re-adopt Slack value on switch back, got ${slackBackPatch?.origin?.nativeChannelId}`,
  );
}
console.log("PASS: switch back to Slack re-adopts nativeChannelId = Dslackdm");

console.log("\nALL CHECKS PASSED — stale per-channel origin fields reset on channel switch.");
