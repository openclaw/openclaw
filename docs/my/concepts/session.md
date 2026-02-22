---
summary: "ချတ်များအတွက် ဆက်ရှင် စီမံခန့်ခွဲမှု စည်းမျဉ်းများ၊ ကီးများနှင့် တည်တံ့သိမ်းဆည်းမှု"
read_when:
  - ဆက်ရှင် ကိုင်တွယ်ပုံ သို့မဟုတ် သိမ်းဆည်းမှုကို ပြင်ဆင်နေချိန်
title: "ဆက်ရှင် စီမံခန့်ခွဲမှု"
---

# ဆက်ရှင် စီမံခန့်ခွဲမှု

OpenClaw treats **one direct-chat session per agent** as primary. Direct chats collapse to `agent:<agentId>:<mainKey>` (default `main`), while group/channel chats get their own keys. `session.mainKey` is honored.

**Direct messages** များကို မည်သို့ အုပ်စုဖွဲ့မည်ကို ထိန်းချုပ်ရန် `session.dmScope` ကို အသုံးပြုပါ—

- `main` (မူလသတ်မှတ်ချက်): ဆက်လက်တည်ရှိမှုအတွက် DM များအားလုံးသည် အဓိက ဆက်ရှင်ကို မျှဝေသည်။
- `per-peer`: ချန်နယ်များအနှံ့ ပို့သူ id အလိုက် သီးခြားခွဲထားသည်။
- `per-channel-peer`: ချန်နယ် + ပို့သူ အလိုက် သီးခြားခွဲထားသည် (multi-user inbox များအတွက် အကြံပြု)။
- `per-account-channel-peer`: isolate by account + channel + sender (recommended for multi-account inboxes).
  Use `session.identityLinks` to map provider-prefixed peer ids to a canonical identity so the same person shares a DM session across channels when using `per-peer`, `per-channel-peer`, or `per-account-channel-peer`.

## Secure DM mode (multi-user setup များအတွက် အကြံပြု)

> **Security Warning:** If your agent can receive DMs from **multiple people**, you should strongly consider enabling secure DM mode. Without it, all users share the same conversation context, which can leak private information between users.

**မူလသတ်မှတ်ချက်များဖြင့် ဖြစ်နိုင်သော ပြဿနာ ဥပမာ—**

- Alice (`<SENDER_A>`) သည် ကိုယ်ရေးကိုယ်တာ အကြောင်းအရာတစ်ခု (ဥပမာ ဆေးကုသမှု ချိန်းဆိုမှု) အကြောင်း သင့်အေးဂျင့်ထံ မက်ဆေ့ချ်ပို့သည်။
- Bob (`<SENDER_B>`) သည် “ကျွန်တော်တို့ ဘာအကြောင်း ပြောနေကြတာလဲ” ဟု မေးသည်။
- DM နှစ်ခုလုံးသည် တူညီသော ဆက်ရှင်ကို မျှဝေနေသောကြောင့် မော်ဒယ်သည် Alice ၏ ယခင်အကြောင်းအရာကို အသုံးပြုပြီး Bob ကို ဖြေဆိုနိုင်ပါသည်။

**ဖြေရှင်းနည်း:** အသုံးပြုသူတစ်ဦးချင်းစီအလိုက် ဆက်ရှင်ကို သီးခြားခွဲရန် `dmScope` ကို သတ်မှတ်ပါ—

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**ဤအခြေအနေများတွင် ဖွင့်သင့်သည်—**

- ပို့သူတစ်ဦးထက်ပိုအတွက် pairing approvals ရှိသည်။
- DM allowlist တွင် အမည်များ အများအပြား ပါဝင်သည်။
- `dmPolicy: "open"` ကို သတ်မှတ်ထားသည်။
- ဖုန်းနံပါတ်များ သို့မဟုတ် အကောင့်များ အများအပြားမှ သင့်အေးဂျင့်ထံ မက်ဆေ့ချ်ပို့နိုင်သည်။

မှတ်ချက်များ—

- Default is `dmScope: "main"` for continuity (all DMs share the main session). This is fine for single-user setups.
- တူညီသော ချန်နယ်ပေါ်ရှိ multi-account inbox များအတွက် `per-account-channel-peer` ကို ဦးစားပေးပါ။
- လူတစ်ယောက်တည်းက ချန်နယ်များအနှံ့ ဆက်သွယ်လာပါက ၎င်းတို့၏ DM ဆက်ရှင်များကို canonical identity တစ်ခုအဖြစ် စုစည်းရန် `session.identityLinks` ကို အသုံးပြုပါ။
- DM ဆက်ရှင် ဆက်တင်များကို `openclaw security audit` ဖြင့် စစ်ဆေးနိုင်ပါသည် ([security](/cli/security) ကို ကြည့်ပါ)။

## Gateway သည် အချက်အလက်၏ အရင်းအမြစ်ဖြစ်သည်

စက်ရှင်အခြေအနေအားလုံးကို **ဂိတ်ဝေး** ("မာစတာ" OpenClaw) ကပိုင်ဆိုင်ထားသည်။ UI ကလိုင်းယင့်များ (macOS အက်ပ်၊ WebChat စသည်) သည် လိုကယ်ဖိုင်များကို ဖတ်ခြင်းအစား စက်ရှင်စာရင်းများနှင့် တိုကင်အရေအတွက်များအတွက် ဂိတ်ဝေးကို မေးမြန်းရမည်။

- **remote mode** တွင် သင်စိတ်ဝင်စားရမည့် ဆက်ရှင်သိမ်းဆည်းမှုသည် သင့် Mac ပေါ်တွင် မရှိဘဲ အဝေးရှိ Gateway ဟို့စ် ပေါ်တွင် ရှိသည်။
- UI များတွင် ပြသသော token အရေအတွက်များသည် gateway ၏ store fields (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`) မှ လာပါသည်။ ကလိုင်းယင့်များသည် စုစုပေါင်းကို “ပြင်ဆင်ရန်” JSONL မှတ်တမ်းများကို မခွဲခြမ်းစိတ်ဖြာပါ။

## State မည်သည့်နေရာတွင် ရှိသည်

- **Gateway ဟို့စ်** ပေါ်တွင်—
  - Store ဖိုင်: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (အေးဂျင့်တစ်ခုချင်းစီအလိုက်)။
- Transcripts: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram topic ဆက်ရှင်များတွင် `.../<SessionId>-topic-<threadId>.jsonl` ကို အသုံးပြုသည်)။
- စတိုးသည် `sessionKey -> { sessionId, updatedAt, ... }` ဆိုသော မြေပုံ (map) တစ်ခုဖြစ်သည်။ အဝင်များကို ဖျက်ခြင်းသည် လုံခြုံသည်၊ လိုအပ်သည့်အခါ ပြန်လည်ဖန်တီးမည်ဖြစ်သည်။
- Group entry များတွင် UI များတွင် ဆက်ရှင်ကို အညွှန်းတပ်ရန် `displayName`, `channel`, `subject`, `room`, နှင့် `space` ပါဝင်နိုင်သည်။
- Session entry များတွင် UI များက ဆက်ရှင် မည်သည့်နေရာမှ လာသည်ကို ရှင်းပြနိုင်ရန် `origin` metadata (label + routing hints) ပါဝင်သည်။
- OpenClaw သည် legacy Pi/Tau ဆက်ရှင် ဖိုလ်ဒါများကို **မဖတ်ပါ**။

## Session pruning

OpenClaw သည် LLM ခေါ်ဆိုမှုမတိုင်မီ မူလအတိုင်း in-memory context ထဲမှ **ဟောင်းနေသော tool ရလဒ်များ** ကို ဖြတ်တောက်သည်။
၎င်းသည် JSONL မှတ်တမ်းကို **ပြန်ရေးခြင်း မရှိပါ**။ [/concepts/session-pruning](/concepts/session-pruning) ကို ကြည့်ပါ။

## Pre-compaction memory flush

စက်ရှင်သည် အလိုအလျောက် ချုံ့သိမ်းခြင်းနီးလာသည့်အခါ OpenClaw သည် **တိတ်ဆိတ်သော memory flush** ကို လုပ်ဆောင်နိုင်ပြီး မော်ဒယ်အား ခိုင်မာသော မှတ်စုများကို ဒစ်စ်ပေါ်သို့ ရေးသားရန် သတိပေးသည်။ ၎င်းကို workspace သည် ရေးနိုင်သော အခြေအနေဖြစ်သောအခါတွင်သာ လုပ်ဆောင်သည်။ [Memory](/concepts/memory) နှင့် [Compaction](/concepts/compaction) ကို ကြည့်ပါ။

## Transport များမှ ဆက်ရှင် ကီးများသို့ မြေပုံချခြင်း

- Direct chats များသည် `session.dmScope` ကို လိုက်နာသည် (မူလသတ်မှတ်ချက် `main`)။
  - `main`: `agent:<agentId>:<mainKey>` (စက်များ/ချန်နယ်များအနှံ့ ဆက်လက်တည်ရှိမှု)။
    - ဖုန်းနံပါတ်များနှင့် ချန်နယ်များ အများအပြားသည် အေးဂျင့်၏ အဓိက ကီးတစ်ခုသို့ မြေပုံချနိုင်ပြီး စကားဝိုင်းတစ်ခုအတွင်းသို့ transport များအဖြစ် လုပ်ဆောင်သည်။
  - `per-peer`: `agent:<agentId>:dm:<peerId>`။
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`။
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId ၏ မူလသတ်မှတ်ချက်မှာ `default` ဖြစ်သည်)။
  - `session.identityLinks` သည် provider-prefixed peer id (ဥပမာ `telegram:123`) နှင့် ကိုက်ညီပါက canonical key သည် `<peerId>` ကို အစားထိုးပြီး လူတစ်ယောက်တည်းသည် ချန်နယ်များအနှံ့ ဆက်ရှင်တစ်ခုကို မျှဝေမည်ဖြစ်သည်။
- Group chats များတွင် state ကို သီးခြားခွဲထားသည်: `agent:<agentId>:<channel>:group:<id>` (room/ချန်နယ်များတွင် `agent:<agentId>:<channel>:channel:<id>` ကို အသုံးပြုသည်)။
  - Telegram forum topic များသည် သီးခြားခွဲရန် group id သို့ `:topic:<threadId>` ကို ဆက်ပေါင်းသည်။
  - Migration အတွက် legacy `group:<id>` ကီးများကို ဆက်လက် အသိအမှတ်ပြုထားသည်။
- Inbound context များတွင် `group:<id>` ကို ဆက်လက် အသုံးပြုနေနိုင်ပြီး ချန်နယ်ကို `Provider` မှ ခန့်မှန်းကာ canonical `agent:<agentId>:<channel>:group:<id>` ပုံစံသို့ ပုံမှန်ပြုလုပ်သည်။
- အခြားရင်းမြစ်များ—
  - Cron jobs: `cron:<job.id>`
  - Webhooks: `hook:<uuid>` (hook မှ တိတိကျကျ သတ်မှတ်မထားပါက)
  - Node runs: `node-<nodeId>`

## Lifecycle

- Reset မူဝါဒ: ဆက်ရှင်များကို သက်တမ်းကုန်သည်အထိ ပြန်လည်အသုံးပြုမည်ဖြစ်ပြီး သက်တမ်းကုန်ဆုံးမှုကို နောက်လာမည့် inbound message တွင် စစ်ဆေးမည်ဖြစ်သည်။
- နေ့စဉ် reset: မူလတန်ဖိုးမှာ **gateway host ၏ local time အရ မနက် 4:00 နာရီ** ဖြစ်ပါသည်။ စက်ရှင်၏ နောက်ဆုံးအပ်ဒိတ်သည် နောက်ဆုံးနေ့စဉ် ပြန်လည်သတ်မှတ်ချိန်ထက် စောပါက စက်ရှင်ကို stale ဟု သတ်မှတ်သည်။
- မလှုပ်ရှားမှုအပေါ် အခြေခံသည့် ပြန်လည်သတ်မှတ်ခြင်း (ရွေးချယ်နိုင်): `idleMinutes` သည် လှိုင်းလျှော မလှုပ်ရှားမှု ပြတင်းပေါက်တစ်ခု ထည့်ပေါင်းသည်။ နေ့စဉ်နှင့် မလှုပ်ရှားမှု ပြန်လည်သတ်မှတ်ချက် နှစ်ခုလုံးကို သတ်မှတ်ထားပါက **အရင်ဆုံး သက်တမ်းကုန်သည့်အရာ** သည် စက်ရှင်အသစ်ကို အတင်းအကျပ် စတင်စေသည်။
- Legacy idle-only: `session.idleMinutes` ကို `session.reset`/`resetByType` မပါဘဲ သတ်မှတ်ထားပါက backward compatibility အတွက် OpenClaw သည် idle-only mode တွင် ဆက်လက် ရှိနေမည်ဖြစ်သည်။
- Type အလိုက် override (ရွေးချယ်နိုင်): `resetByType` သည် `direct`, `group`, နှင့် `thread` session များအတွက် policy ကို override လုပ်ခွင့်ပေးပါသည် (thread = Slack/Discord threads, Telegram topics, Matrix threads ကို connector က ပေးသောအခါ)။
- Per-channel override (ရွေးချယ်နိုင်): `resetByChannel` သည် ချန်နယ်တစ်ခုအတွက် reset မူဝါဒကို ပြန်လည်သတ်မှတ်ပြီး (`reset`/`resetByType` ထက် ဦးစားပေး အသက်ဝင်သည်) ချန်နယ်အတွက် ဆက်ရှင်အမျိုးအစားအားလုံးတွင် အသက်ဝင်သည်။
- Reset triggers: တိတိကျကျ `/new` သို့မဟုတ် `/reset` (နှင့် `resetTriggers` ထဲရှိ အပိုများ) သည် session id အသစ်ကို စတင်ပြီး မက်ဆေ့ချ်၏ ကျန်ရှိသော အပိုင်းကို ဆက်လက်ပို့ဆောင်ပါသည်။ `/new <model>` သည် မော်ဒယ် alias၊ `provider/model` သို့မဟုတ် provider အမည် (fuzzy match) ကို လက်ခံပြီး စက်ရှင်အသစ်၏ မော်ဒယ်ကို သတ်မှတ်သည်။ `/new` သို့မဟုတ် `/reset` ကို တစ်ခုတည်းပို့ပါက OpenClaw သည် ပြန်လည်သတ်မှတ်မှုကို အတည်ပြုရန် အတိုချုံး “မင်္ဂလာပါ” နှုတ်ဆက်အလှည့်ကို လုပ်ဆောင်သည်။
- Manual reset: Store ထဲမှ သီးခြားကီးများကို ဖျက်ခြင်း သို့မဟုတ် JSONL transcript ကို ဖယ်ရှားပါ။ နောက်လာမည့် မက်ဆေ့ချ်တွင် ၎င်းတို့ကို ပြန်လည်ဖန်တီးမည်ဖြစ်သည်။
- Isolated cron jobs များသည် run တစ်ကြိမ်လျှင် idle reuse မရှိဘဲ `sessionId` အသစ်တစ်ခုကို အမြဲတမ်း ထုတ်ပေးသည်။

## Send policy (ရွေးချယ်နိုင်)

Session id တစ်ခုချင်းစီကို မဖော်ပြဘဲ ဆက်ရှင်အမျိုးအစားအချို့အတွက် ပို့ဆောင်မှုကို တားဆီးပါ။

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

Runtime override (ပိုင်ရှင်သာ):

- `/send on` → ဤဆက်ရှင်အတွက် ခွင့်ပြု
- `/send off` → ဤဆက်ရှင်အတွက် ပိတ်ပင်
- `/send inherit` → override ကို ရှင်းလင်းပြီး config စည်းမျဉ်းများကို အသုံးပြု
  ဤအမိန့်များကို သီးသန့် မက်ဆေ့ချ်များအဖြစ် ပို့ပါ၊ သို့မှသာ မှတ်ပုံတင်နိုင်ပါသည်။

## Configuration (ရွေးချယ်နိုင်သော rename ဥပမာ)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## Inspecting

- `openclaw status` — store လမ်းကြောင်းနှင့် မကြာသေးမီ ဆက်ရှင်များကို ပြသည်။
- `openclaw sessions --json` — entry အားလုံးကို ထုတ်ပြသည် (`--active <minutes>` ဖြင့် filter လုပ်နိုင်သည်)။
- `openclaw gateway call sessions.list --params '{}'` — လည်ပတ်နေသော gateway မှ ဆက်ရှင်များကို ရယူသည် (remote gateway ဝင်ရောက်ရန် `--url`/`--token` ကို အသုံးပြုပါ)။
- ချတ်အတွင်း `/status` ကို သီးသန့် မက်ဆေ့ချ်အဖြစ် ပို့ပါက အေးဂျင့်သည် ရောက်ရှိနိုင်မှု ရှိမရှိ၊ ဆက်ရှင် context ကို မည်မျှ အသုံးပြုထားသည်၊ လက်ရှိ thinking/verbose toggle များ၊ နှင့် သင့် WhatsApp web creds ကို နောက်ဆုံး refresh လုပ်ထားသည့် အချိန်ကို မြင်နိုင်ပါသည် (relink လိုအပ်မှုကို တွေ့ရှိရန် အထောက်အကူပြုသည်)။
- `/context list` သို့မဟုတ် `/context detail` ကို ပို့၍ system prompt နှင့် inject လုပ်ထားသော workspace ဖိုင်များ (နှင့် context အများဆုံး ပါဝင်သည့် အစိတ်အပိုင်းများ) ကို ကြည့်နိုင်ပါသည်။
- `/stop` ကို သီးသန့် မက်ဆေ့ချ်အဖြစ် ပို့၍ လက်ရှိ run ကို ရပ်တန့်စေခြင်း၊ ထိုဆက်ရှင်အတွက် queue ထဲရှိ followup များကို ဖျက်ခြင်း၊ နှင့် ၎င်းမှ စတင်ထားသော sub-agent run များအားလုံးကို ရပ်တန့်စေပါသည် (အဖြေတွင် ရပ်တန့်ခဲ့သော အရေအတွက် ပါဝင်သည်)။
- `/compact` (ရွေးချယ်နိုင်သော ညွှန်ကြားချက်များ) ကို သီးခြားမက်ဆေ့ချ်အဖြစ် ပို့၍ ဟောင်းနေသော context ကို အကျဉ်းချုပ်ကာ window နေရာလွတ် ပြန်လည်ရယူပါ။ [/concepts/compaction](/concepts/compaction) ကို ကြည့်ပါ။
- JSONL transcript များကို တိုက်ရိုက် ဖွင့်၍ ပြည့်စုံသော turn များကို စစ်ဆေးနိုင်ပါသည်။

## Tips

- အဓိက ကီးကို 1:1 traffic အတွက်သာ သီးသန့်ထားပြီး group များကို ၎င်းတို့၏ ကိုယ်ပိုင် ကီးများကို အသုံးပြုစေပါ။
- Cleanup ကို အလိုအလျောက်လုပ်ဆောင်ရာတွင် အခြား context များကို ထိန်းသိမ်းရန် store အပြည့်ကို မဖျက်ဘဲ သီးခြား ကီးများကိုသာ ဖျက်ပါ။

## Session origin metadata

ဆက်ရှင် entry တစ်ခုချင်းစီသည် မည်သည့်နေရာမှ လာသည်ကို (best-effort) `origin` တွင် မှတ်တမ်းတင်ထားသည်—

- `label`: လူဖတ်နိုင်သော label (conversation label + group subject/ချန်နယ် မှ ဖြေရှင်းထားသည်)
- `provider`: normalized ချန်နယ် id (extension များအပါအဝင်)
- `from`/`to`: inbound envelope မှ raw routing id များ
- `accountId`: provider အကောင့် id (multi-account ဖြစ်ပါက)
- `threadId`: ချန်နယ်က ထောက်ပံ့ပါက thread/ခေါင်းစဉ် ID
  မူလလာရာ (origin) ဖီးလ်များကို direct messages၊ channels နှင့် groups အတွက် ဖြည့်သွင်းထားသည်။ connector တစ်ခုက ပို့ဆောင်မှု လမ်းကြောင်းကိုသာ အပ်ဒိတ်လုပ်ပါက (ဥပမာ၊ DM အဓိက စက်ရှင်ကို အသစ်အဆန်းထားရန်) စက်ရှင်၏ explainer metadata ကို ထိန်းသိမ်းနိုင်ရန် inbound context ကို ပေးရပါမည်။ Extensions များသည် inbound context ထဲတွင် `ConversationLabel`, `GroupSubject`, `GroupChannel`, `GroupSpace`, နှင့် `SenderName` ကို ပို့ပြီး `recordSessionMetaFromInbound` ကို ခေါ်ခြင်း (သို့မဟုတ် တူညီသော context ကို `updateLastRoute` သို့ ပေးပို့ခြင်း) ဖြင့် ယင်းကို လုပ်ဆောင်နိုင်သည်။
