---
summary: "Sub-agents: တောင်းဆိုသူ၏ ချတ်ချန်နယ်သို့ ရလဒ်များကို ကြေညာပြန်လည်ပို့သည့် သီးခြားခွဲထားသော agent run များကို spawn ပြုလုပ်ခြင်း"
read_when:
  - agent မှတစ်ဆင့် နောက်ခံ/အပြိုင် လုပ်ဆောင်မှုများ လိုအပ်သည့်အခါ
  - sessions_spawn သို့မဟုတ် sub-agent tool policy ကို ပြောင်းလဲနေသည့်အခါ
title: "Sub-Agents"
---

# Sub-agents

Sub-agents are background agent runs spawned from an existing agent run. They run in their own session (`agent:<agentId>:subagent:<uuid>`) and, when finished, **announce** their result back to the requester chat channel.

## Slash command

**လက်ရှိ session** အတွက် sub-agent run များကို စစ်ဆေးခြင်း သို့မဟုတ် ထိန်းချုပ်ရန် `/subagents` ကို အသုံးပြုပါ–

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` သည် run metadata (အခြေအနေ၊ အချိန်တံဆိပ်များ၊ session id၊ transcript path၊ cleanup) ကို ပြသပါသည်။

အဓိက ရည်ရွယ်ချက်များ–

- အဓိက run ကို မတားဆီးဘဲ “research / long task / slow tool” အလုပ်များကို အပြိုင်လုပ်ဆောင်နိုင်ရန်။
- Sub-agent များကို မူလအားဖြင့် သီးခြားခွဲထားရန် (session ခွဲခြားခြင်း + ရွေးချယ်နိုင်သော sandboxing)။
- Tool မျက်နှာပြင်ကို အလွယ်တကူ မမှားယွင်းအသုံးချနိုင်အောင် ထိန်းသိမ်းရန်– sub-agent များသည် မူလအားဖြင့် session tools မရရှိပါ။
- Nested fan-out ကို ရှောင်ရှားရန်– sub-agent များသည် sub-agent များကို ထပ်မံ spawn မလုပ်နိုင်ပါ။

Cost note: each sub-agent has its **own** context and token usage. For heavy or repetitive
tasks, set a cheaper model for sub-agents and keep your main agent on a higher-quality model.
You can configure this via `agents.defaults.subagents.model` or per-agent overrides.

## Tool

`sessions_spawn` ကို အသုံးပြုပါ–

- Sub-agent run တစ်ခုကို စတင်သည် (`deliver: false`, global lane: `subagent`)
- ထို့နောက် announce step ကို လုပ်ဆောင်ပြီး announce reply ကို တောင်းဆိုသူ၏ ချတ်ချန်နယ်သို့ ပို့တင်သည်
- မူလ model– `agents.defaults.subagents.model` (သို့မဟုတ် per-agent `agents.list[].subagents.model`) ကို မသတ်မှတ်ပါက ခေါ်ယူသူမှ ဆက်ခံပါသည်; သို့သော် တိတိကျကျ သတ်မှတ်ထားသော `sessions_spawn.model` သည် အမြဲ ဦးစားပေးပါသည်။
- မူလ thinking– `agents.defaults.subagents.thinking` (သို့မဟုတ် per-agent `agents.list[].subagents.thinking`) ကို မသတ်မှတ်ပါက ခေါ်ယူသူမှ ဆက်ခံပါသည်; သို့သော် တိတိကျကျ သတ်မှတ်ထားသော `sessions_spawn.thinking` သည် အမြဲ ဦးစားပေးပါသည်။

Tool parameters–

- `task` (လိုအပ်)
- `label?` (ရွေးချယ်နိုင်)
- `agentId?` (ရွေးချယ်နိုင်; ခွင့်ပြုထားပါက အခြား agent id အောက်တွင် spawn ပြုလုပ်ရန်)
- `model?` (ရွေးချယ်နိုင်; sub-agent model ကို override လုပ်သည်; မမှန်ကန်သော တန်ဖိုးများကို ကျော်လွှားပြီး သတိပေးချက်နှင့်အတူ မူလ model ပေါ်တွင် run လုပ်ပါသည်)
- `thinking?` (ရွေးချယ်နိုင်; sub-agent run အတွက် thinking level ကို override လုပ်သည်)
- `runTimeoutSeconds?` (မူလ `0`; သတ်မှတ်ပါက N စက္ကန့်အကြာ sub-agent run ကို ဖျက်သိမ်းပါသည်)
- `cleanup?` (`delete|keep`, မူလ `keep`)

Allowlist–

- `agents.list[].subagents.allowAgents`: list of agent ids that can be targeted via `agentId` (`["*"]` to allow any). Default: only the requester agent.

Discovery–

- `agents_list` ကို အသုံးပြုပြီး `sessions_spawn` အတွက် လက်ရှိ ခွင့်ပြုထားသော agent id များကို ကြည့်ရှုနိုင်ပါသည်။

Auto-archive–

- Sub-agent session များကို `agents.defaults.subagents.archiveAfterMinutes` အပြီး အလိုအလျောက် archive ပြုလုပ်ပါသည် (မူလ– 60)။
- Archive uses `sessions.delete` and renames the transcript to `*.deleted.<timestamp>` (same folder).
- `cleanup: "delete"` သည် announce ပြီးချင်း ချက်ချင်း archive ပြုလုပ်ပါသည် (transcript ကို အမည်ပြောင်းထားခြင်းဖြင့် ဆက်လက်ထားရှိသည်)။
- Auto-archive သည် best-effort ဖြစ်ပါသည်; gateway ပြန်လည်စတင်ပါက စောင့်ဆိုင်းနေသော timer များ ပျောက်ဆုံးနိုင်ပါသည်။
- `runTimeoutSeconds` does **not** auto-archive; it only stops the run. The session remains until auto-archive.

## Authentication

Sub-agent authentication ကို session type မဟုတ်ဘဲ **agent id** အပေါ် အခြေခံ၍ ဖြေရှင်းပါသည်–

- Sub-agent session key သည် `agent:<agentId>:subagent:<uuid>` ဖြစ်သည်။
- Auth store ကို ထို agent ၏ `agentDir` မှ load လုပ်ပါသည်။
- အဓိက agent ၏ auth profiles များကို **fallback** အဖြစ် ပေါင်းထည့်ပါသည်; အငြင်းပွားမှုရှိပါက agent profiles များက အဓိက profiles များကို အစားထိုးပါသည်။

Note: the merge is additive, so main profiles are always available as fallbacks. Fully isolated auth per agent is not supported yet.

## Announce

Sub-agent များသည် announce step မှတစ်ဆင့် ပြန်လည်အစီရင်ခံပါသည်–

- Announce step သည် sub-agent session အတွင်း (requester session မဟုတ်) လည်ပတ်ပါသည်။
- Sub-agent က တိတိကျကျ `ANNOUNCE_SKIP` ဟု ပြန်ကြားပါက မည်သည့်အရာမျှ မတင်ပါ။
- မဟုတ်ပါက announce reply ကို follow-up `agent` call (`deliver=true`) မှတစ်ဆင့် တောင်းဆိုသူ၏ ချတ်ချန်နယ်သို့ ပို့တင်ပါသည်။
- Announce reply များသည် ရရှိနိုင်ပါက thread/topic routing (Slack threads, Telegram topics, Matrix threads) ကို ထိန်းသိမ်းထားပါသည်။
- Announce မက်ဆေ့ချ်များကို တည်ငြိမ်သော template သို့ normalize ပြုလုပ်ပါသည်–
  - `Status:` ကို run outcome (`success`, `error`, `timeout`, သို့မဟုတ် `unknown`) မှ ဆင်းသက်အခြေခံ၍ ထုတ်ယူသည်။
  - `Result:` သည် announce step မှ summary အကြောင်းအရာ (မရှိပါက `(not available)`) ဖြစ်သည်။
  - `Notes:` သည် အမှားအသေးစိတ်များနှင့် အသုံးဝင်သော context အချက်အလက်များ ဖြစ်သည်။
- `Status` ကို model output မှ ခန့်မှန်းမထားပါ; runtime outcome signals မှ ရယူပါသည်။

Announce payload များတွင် (wrapped ဖြစ်နေလည်း) အဆုံးတွင် stats line တစ်ကြောင်း ပါဝင်ပါသည်–

- Runtime (ဥပမာ– `runtime 5m12s`)
- Token အသုံးပြုမှု (input/output/စုစုပေါင်း)
- Model pricing ကို သတ်မှတ်ထားပါက ခန့်မှန်းကုန်ကျစရိတ် (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId`, နှင့် transcript path (အဓိက agent က `sessions_history` မှတစ်ဆင့် history ကို ရယူနိုင်ရန် သို့မဟုတ် disk ပေါ်ရှိ ဖိုင်ကို စစ်ဆေးနိုင်ရန်)

## Tool Policy (sub-agent tools)

မူလအားဖြင့် sub-agent များသည် **session tools များကို ချန်လှပ်၍ tool အားလုံး** ကို ရရှိပါသည်–

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Config မှတစ်ဆင့် override ပြုလုပ်နိုင်ပါသည်–

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## Concurrency

Sub-agent များသည် သီးသန့် in-process queue lane တစ်ခုကို အသုံးပြုပါသည်–

- Lane name– `subagent`
- Concurrency– `agents.defaults.subagents.maxConcurrent` (မူလ `8`)

## Stopping

- တောင်းဆိုသူ၏ ချတ်ချန်နယ်တွင် `/stop` ကို ပို့လိုက်ပါက requester session ကို ဖျက်သိမ်းပြီး ထို session မှ spawn ပြုလုပ်ထားသော active sub-agent run များအားလုံးကို ရပ်တန့်ပါသည်။

## Limitations

- Sub-agent announce is **best-effort**. If the gateway restarts, pending “announce back” work is lost.
- Sub-agent များသည် gateway process ရဲ့ အရင်းအမြစ်များကို မျှဝေသုံးစွဲနေဆဲဖြစ်သဖြင့် `maxConcurrent` ကို လုံခြုံရေးအတွက် safety valve အဖြစ် သဘောထားပါ။
- `sessions_spawn` သည် အမြဲ non-blocking ဖြစ်ပါသည်– `{ status: "accepted", runId, childSessionKey }` ကို ချက်ချင်း ပြန်ပေးပါသည်။
- Sub-agent context တွင် `AGENTS.md` + `TOOLS.md` ကိုသာ inject ပြုလုပ်ပါသည် (`SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, သို့မဟုတ် `BOOTSTRAP.md` မပါဝင်ပါ)
