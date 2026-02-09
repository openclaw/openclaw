---
summary: "ဆက်ရှင်များကို စာရင်းပြုစုခြင်း၊ မှတ်တမ်းများကို ရယူခြင်းနှင့် ဆက်ရှင်အပြန်အလှန် မက်ဆေ့ချ်ပို့ခြင်းအတွက် အေးဂျင့် ဆက်ရှင် ကိရိယာများ"
read_when:
  - ဆက်ရှင် ကိရိယာများကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ပြောင်းလဲခြင်း
title: "ဆက်ရှင် ကိရိယာများ"
---

# ဆက်ရှင် ကိရိယာများ

ရည်မှန်းချက် — အသုံးချရလွယ်ကူပြီး မှားယွင်းအသုံးချရန် ခက်ခဲသော ကိရိယာအစုကို ပံ့ပိုးပေးရန်ဖြစ်ပြီး အေးဂျင့်များက ဆက်ရှင်များကို စာရင်းပြုစုနိုင်ရန်၊ မှတ်တမ်းကို ရယူနိုင်ရန်နှင့် အခြား ဆက်ရှင်သို့ ပို့နိုင်ရန် ဖြစ်သည်။

## ကိရိယာ အမည်များ

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Key မော်ဒယ်

- အဓိက တိုက်ရိုက် ချတ် ဘတ်ကက်သည် အမြဲတမ်း literal key `"main"` ဖြစ်ပြီး (လက်ရှိ အေးဂျင့်၏ အဓိက key သို့ ဖြေရှင်းထားသည်)။
- အုပ်စု ချတ်များတွင် `agent:<agentId>:<channel>:group:<id>` သို့မဟုတ် `agent:<agentId>:<channel>:channel:<id>` ကို အသုံးပြုသည် (key အပြည့်အစုံကို ပို့ပါ)။
- Cron jobs များတွင် `cron:<job.id>` ကို အသုံးပြုသည်။
- Hooks များတွင် သီးခြား သတ်မှတ်မထားလျှင် `hook:<uuid>` ကို အသုံးပြုသည်။
- Node ဆက်ရှင်များတွင် သီးခြား သတ်မှတ်မထားလျှင် `node-<nodeId>` ကို အသုံးပြုသည်။

`global` and `unknown` are reserved values and are never listed. `session.scope = "global"` ဖြစ်ပါက caller များက `global` ကို မမြင်ရစေရန် tools အားလုံးအတွက် `main` သို့ alias လုပ်ပါသည်။

## sessions_list

ဆက်ရှင်များကို row များအဖြစ် array တစ်ခုအနေနှင့် စာရင်းပြုစုပါ။

Parameters:

- `kinds?: string[]` filter: `"main" | "group" | "cron" | "hook" | "node" | "other"` များထဲမှ မည်သည့်အရာမဆို
- `limit?: number` အများဆုံး row အရေအတွက် (မူလတန်ဖိုး: ဆာဗာ မူလတန်ဖိုး၊ ဥပမာ 200 အထိ clamp)
- `activeMinutes?: number` N မိနစ်အတွင်း အပ်ဒိတ်လုပ်ထားသော ဆက်ရှင်များသာ
- `messageLimit?: number` 0 = မက်ဆေ့ချ် မပါ (မူလ 0)၊ >0 = နောက်ဆုံး မက်ဆေ့ချ် N ခု ပါဝင်စေသည်

Behavior:

- `messageLimit > 0` သည် ဆက်ရှင်တစ်ခုချင်းစီအတွက် `chat.history` ကို ရယူပြီး နောက်ဆုံး မက်ဆေ့ချ် N ခုကို ထည့်သွင်းပေးသည်။
- စာရင်းထုတ်လွှင့်မှုတွင် ကိရိယာရလဒ်များကို စစ်ထုတ်ထားသည်; ကိရိယာ မက်ဆေ့ချ်များအတွက် `sessions_history` ကို အသုံးပြုပါ။
- **sandboxed** အေးဂျင့် ဆက်ရှင်တွင် လည်ပတ်နေပါက ဆက်ရှင် ကိရိယာများသည် မူလအားဖြင့် **spawned-only visibility** ကို အသုံးပြုသည် (အောက်တွင် ကြည့်ပါ)။

Row ပုံစံ (JSON):

- `key`: ဆက်ရှင် key (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (ရရှိနိုင်ပါက အုပ်စု ပြသ အမှတ်အသား)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (သတ်မှတ်ထားပါက ဆက်ရှင် override)
- `lastChannel`, `lastTo`
- `deliveryContext` (ရရှိနိုင်ပါက `{ channel, to, accountId }` ကို normalized ပြုလုပ်ထားသည်)
- `transcriptPath` (store dir + sessionId မှ ဆင်းသက်ထုတ်ယူထားသော best‑effort လမ်းကြောင်း)
- `messages?` (`messageLimit > 0` ဖြစ်သည့်အခါသာ)

## sessions_history

ဆက်ရှင်တစ်ခုအတွက် transcript ကို ရယူပါ။

Parameters:

- `sessionKey` (လိုအပ်သည်; ဆက်ရှင် key သို့မဟုတ် `sessions_list` မှ `sessionId` ကို လက်ခံသည်)
- `limit?: number` အများဆုံး မက်ဆေ့ချ်အရေအတွက် (ဆာဗာမှ clamp)
- `includeTools?: boolean` (မူလ false)

Behavior:

- `includeTools=false` သည် `role: "toolResult"` မက်ဆေ့ချ်များကို စစ်ထုတ်သည်။
- မက်ဆေ့ချ်များ array ကို raw transcript ဖော်မတ်ဖြင့် ပြန်ပေးသည်။
- `sessionId` ကို ပေးထားပါက OpenClaw သည် သက်ဆိုင်ရာ ဆက်ရှင် key သို့ ဖြေရှင်းပေးသည် (id မရှိပါက အမှားပြန်ပေးသည်)။

## sessions_send

အခြား ဆက်ရှင်တစ်ခုသို့ မက်ဆေ့ချ် ပို့ပါ။

Parameters:

- `sessionKey` (လိုအပ်သည်; ဆက်ရှင် key သို့မဟုတ် `sessions_list` မှ `sessionId` ကို လက်ခံသည်)
- `message` (လိုအပ်သည်)
- `timeoutSeconds?: number` (မူလ >0; 0 = fire‑and‑forget)

Behavior:

- `timeoutSeconds = 0`: enqueue လုပ်ပြီး `{ runId, status: "accepted" }` ကို ပြန်ပေးသည်။
- `timeoutSeconds > 0`: ပြီးစီးမှုအတွက် N စက္ကန့်အထိ စောင့်ပြီး `{ runId, status: "ok", reply }` ကို ပြန်ပေးသည်။
- If wait times out: `{ runId, status: "timeout", error }`. Run continues; call `sessions_history` later.
- Run မအောင်မြင်ပါက: `{ runId, status: "error", error }`။
- Primary run ပြီးဆုံးပြီးနောက် delivery announce run များကို ကြေညာသည်၊ best‑effort ဖြစ်ပြီး `status: "ok"` သည် announce ပို့ပြီးကြောင်းကို အာမခံမပေးပါ။
- Gateway（ဂိတ်ဝေး） `agent.wait` မှတစ်ဆင့် စောင့်ဆိုင်းခြင်း (server‑side) ကို အသုံးပြုသဖြင့် ပြန်လည်ချိတ်ဆက်မှုများကြောင့် စောင့်ဆိုင်းမှု မပျက်သွားပါ။
- Primary run အတွက် agent‑to‑agent မက်ဆေ့ချ် context ကို ထည့်သွင်းပေးသည်။
- Primary run ပြီးဆုံးပြီးနောက် OpenClaw သည် **reply‑back loop** ကို လည်ပတ်စေသည်:
  - Round 2+ တွင် တောင်းဆိုသူနှင့် ရည်မှန်းထားသော အေးဂျင့်တို့ အပြန်အလှန် ပြောင်းလဲလည်ပတ်သည်။
  - Ping‑pong ကို ရပ်ရန် `REPLY_SKIP` ကို တိတိကျကျ ပြန်ကြားပါ။
  - အများဆုံး turn အရေအတွက်မှာ `session.agentToAgent.maxPingPongTurns` (0–5၊ မူလ 5) ဖြစ်သည်။
- Loop ပြီးဆုံးသည့်အခါ OpenClaw သည် **agent‑to‑agent announce step** ကို လည်ပတ်စေသည် (ရည်မှန်းထားသော အေးဂျင့်သာ):
  - တိတ်ဆိတ်နေရန် `ANNOUNCE_SKIP` ကို တိတိကျကျ ပြန်ကြားပါ။
  - အခြား မည်သည့်ပြန်ကြားချက်မဆို ရည်မှန်းထားသော ချန်နယ်သို့ ပို့သည်။
  - Announce step တွင် မူလ တောင်းဆိုချက် + round‑1 ပြန်ကြားချက် + နောက်ဆုံး ping‑pong ပြန်ကြားချက်တို့ ပါဝင်သည်။

## Channel Field

- အုပ်စုများအတွက် `channel` သည် ဆက်ရှင် entry တွင် မှတ်တမ်းတင်ထားသော ချန်နယ် ဖြစ်သည်။
- တိုက်ရိုက် ချတ်များအတွက် `channel` သည် `lastChannel` မှ mapping လုပ်ထားသည်။
- Cron/hook/node များအတွက် `channel` သည် `internal` ဖြစ်သည်။
- မရှိပါက `channel` သည် `unknown` ဖြစ်သည်။

## လုံခြုံရေး / ပို့ဆောင်ရေး မူဝါဒ

ချန်နယ်/ချတ် အမျိုးအစားအလိုက် မူဝါဒအခြေခံ ပိတ်ဆို့ခြင်း (session id အလိုက် မဟုတ်ပါ)။

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Runtime override (ဆက်ရှင် entry တစ်ခုချင်းစီအလိုက်):

- `sendPolicy: "allow" | "deny"` (မသတ်မှတ်ပါက config ကို အမွေဆက်ခံ)
- `sessions.patch` သို့မဟုတ် ပိုင်ရှင်သာ အသုံးပြုနိုင်သော `/send on|off|inherit` (standalone မက်ဆေ့ချ်) မှတစ်ဆင့် သတ်မှတ်နိုင်သည်။

Enforcement အချက်များ:

- `chat.send` / `agent` (Gateway（ဂိတ်ဝေး）)
- auto‑reply delivery logic

## sessions_spawn

သီးခြား ဆက်ရှင်တစ်ခုအတွင်း sub‑agent run ကို စတင်ပြီး ရလဒ်ကို တောင်းဆိုသူ ချတ် ချန်နယ်သို့ ကြေညာပါ။

Parameters:

- `task` (လိုအပ်သည်)
- `label?` (ရွေးချယ်နိုင်; logs/UI အတွက် အသုံးပြုသည်)
- `agentId?` (ရွေးချယ်နိုင်; ခွင့်ပြုထားပါက အခြား agent id အောက်တွင် spawn)
- `model?` (ရွေးချယ်နိုင်; sub‑agent မော်ဒယ်ကို override ပြုလုပ်သည်; မမှန်ကန်သော တန်ဖိုးများတွင် အမှား)
- `runTimeoutSeconds?` (မူလ 0; သတ်မှတ်ထားပါက N စက္ကန့်ပြီးနောက် sub‑agent run ကို အဆုံးသတ်)
- `cleanup?` (`delete|keep`၊ မူလ `keep`)

Allowlist:

- `agents.list[].subagents.allowAgents`: list of agent ids allowed via `agentId` (`["*"]` to allow any). Default: only the requester agent.

Discovery:

- `agents_list` ကို အသုံးပြု၍ `sessions_spawn` အတွက် ခွင့်ပြုထားသော agent id များကို ရှာဖွေပါ။

Behavior:

- `deliver: false` ဖြင့် `agent:<agentId>:subagent:<uuid>` ဆက်ရှင်အသစ်ကို စတင်သည်။
- Sub‑agent များတွင် မူလအားဖြင့် ကိရိယာအပြည့်အစုံကို အသုံးပြုနိုင်သော်လည်း **session tools** ကို ဖယ်ရှားထားသည် (`tools.subagents.tools` ဖြင့် ပြင်ဆင်နိုင်သည်)။
- Sub‑agent များသည် `sessions_spawn` ကို ခေါ်ရန် ခွင့်မပြုပါ (sub‑agent → sub‑agent spawning မရှိ)။
- အမြဲ non‑blocking ဖြစ်ပြီး `{ status: "accepted", runId, childSessionKey }` ကို ချက်ချင်း ပြန်ပေးသည်။
- ပြီးဆုံးပြီးနောက် OpenClaw သည် sub‑agent **announce step** ကို လည်ပတ်စေပြီး ရလဒ်ကို တောင်းဆိုသူ ချတ် ချန်နယ်သို့ ပို့သည်။
- Announce step အတွင်း တိတ်ဆိတ်နေရန် `ANNOUNCE_SKIP` ကို တိတိကျကျ ပြန်ကြားပါ။
- Announce ပြန်ကြားချက်များကို `Status`/`Result`/`Notes` သို့ normalized ပြုလုပ်ထားပြီး `Status` သည် runtime ရလဒ်မှ လာသည် (မော်ဒယ် စာသားမဟုတ်)။
- Sub‑agent ဆက်ရှင်များကို `agents.defaults.subagents.archiveAfterMinutes` (မူလ: 60) ပြီးနောက် အလိုအလျောက် archive လုပ်သည်။
- Announce ပြန်ကြားချက်များတွင် stats line (runtime, tokens, sessionKey/sessionId, transcript path နှင့် ရွေးချယ်နိုင်သော cost) ပါဝင်သည်။

## Sandbox ဆက်ရှင် မြင်နိုင်မှု

Sandboxed ဆက်ရှင်များသည် session tools ကို အသုံးပြုနိုင်သော်လည်း မူလအားဖြင့် `sessions_spawn` မှတစ်ဆင့် ကိုယ်တိုင် spawn လုပ်ထားသော ဆက်ရှင်များကိုသာ မြင်နိုင်သည်။

Config:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
