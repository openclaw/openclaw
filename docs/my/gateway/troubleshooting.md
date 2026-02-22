---
summary: "Gateway၊ ချန်နယ်များ၊ အလိုအလျောက်လုပ်ဆောင်မှု၊ နိုဒ်များနှင့် ဘရောက်ဇာအတွက် အနက်ရှိုင်းဆုံး ပြဿနာဖြေရှင်းမှု လမ်းညွှန်စာအုပ်"
read_when:
  - ပြဿနာဖြေရှင်းရေး ဟပ်မှ အနက်ရှိုင်းဆုံး ခွဲခြားစစ်ဆေးရန် ဒီနေရာကို ညွှန်ပြထားသောအခါ
  - တိကျသော အမိန့်များပါဝင်သည့် လက္ခဏာအခြေပြု လမ်းညွှန်ပိုင်းများ လိုအပ်သောအခါ
title: "ပြဿနာဖြေရှင်းခြင်း"
---

# Gateway ပြဿနာဖြေရှင်းခြင်း

ဤစာမျက်နှာသည် deep runbook ဖြစ်ပါသည်။
မြန်ဆန်သော triage flow ကို အရင်လိုချင်ပါက [/help/troubleshooting](/help/troubleshooting) မှ စတင်ပါ။

## Command ladder

အောက်ပါအမိန့်များကို အရင်ဆုံး၊ ဒီအစီအစဉ်အတိုင်း လုပ်ဆောင်ပါ–

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

ကျန်းမာနေသည့် အခြေအနေတွင် မျှော်မှန်းထားသည့် လက္ခဏာများ–

- `openclaw gateway status` တွင် `Runtime: running` နှင့် `RPC probe: ok` ကို ပြသသည်။
- `openclaw doctor` သည် ပိတ်ဆို့နေသော ဖွဲ့စည်းပြင်ဆင်မှု/ဝန်ဆောင်မှု ပြဿနာများ မရှိကြောင်း အစီရင်ခံသည်။
- `openclaw channels status --probe` တွင် ချိတ်ဆက်ပြီး/အသင့်ရှိနေသော ချန်နယ်များကို ပြသသည်။

## အဖြေမရှိခြင်း

ချန်နယ်များ အလုပ်လုပ်နေသော်လည်း အဖြေမရပါက၊ မည်သည့်အရာကိုမျှ ပြန်လည်ချိတ်ဆက်မလုပ်မီ routing နှင့် policy ကို စစ်ဆေးပါ။

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

ကြည့်ရှုရန်–

- DM ပို့သူများအတွက် Pairing စောင့်ဆိုင်းနေခြင်း။
- အုပ်စု mention gating (`requireMention`, `mentionPatterns`)။
- ချန်နယ်/အုပ်စု allowlist မကိုက်ညီခြင်းများ။

ပုံမှန်တွေ့ရသော လက္ခဏာများ–

- `drop guild message (mention required` → mention မပါမချင်း အုပ်စုမက်ဆေ့ချ်ကို လျစ်လျူရှုထားသည်။
- `pairing request` → ပို့သူအား အတည်ပြုချက်လိုအပ်သည်။
- `blocked` / `allowlist` → ပို့သူ/ချန်နယ်ကို policy ဖြင့် စစ်ထုတ်ထားသည်။

ဆက်စပ်–

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Dashboard control UI ချိတ်ဆက်မှု

dashboard/control UI မချိတ်ဆက်နိုင်ပါက URL၊ auth mode နှင့် secure context ဆိုင်ရာ အယူအဆများကို အတည်ပြုစစ်ဆေးပါ။

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

ကြည့်ရှုရန်–

- မှန်ကန်သော probe URL နှင့် dashboard URL။
- client နှင့် Gateway အကြား Auth mode/token မကိုက်ညီခြင်း။
- device identity လိုအပ်သောအခါ HTTP အသုံးပြုထားခြင်း။

ပုံမှန်တွေ့ရသော လက္ခဏာများ–

- `device identity required` → secure context မဟုတ်ခြင်း သို့မဟုတ် device auth မရှိခြင်း။
- `unauthorized` / ပြန်လည်ချိတ်ဆက်နေသည့် loop → token/password မကိုက်ညီခြင်း။
- `gateway connect failed:` → ဟို့စ်/ပို့တ်/URL ပစ်မှတ် မှားယွင်းခြင်း။

ဆက်စပ်–

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway ဝန်ဆောင်မှု မလည်ပတ်ခြင်း

ဝန်ဆောင်မှုကို ထည့်သွင်းထားပြီးသားဖြစ်သော်လည်း process မတည်မြဲပါက ဒီအပိုင်းကို အသုံးပြုပါ။

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

ကြည့်ရှုရန်–

- `Runtime: stopped` နှင့် အထွက်အချက်အလက် အကြံပြုချက်များ။
- ဝန်ဆောင်မှု ဖွဲ့စည်းပြင်ဆင်မှု မကိုက်ညီခြင်း (`Config (cli)` နှင့် `Config (service)`)။
- ပို့တ်/နားထောင်သူ အပြိုင်အဆိုင် ဖြစ်ခြင်းများ။

ပုံမှန်တွေ့ရသော လက္ခဏာများ–

- `Gateway start blocked: set gateway.mode=local` → local gateway mode ကို ဖွင့်မထားခြင်း။
- `refusing to bind gateway ... without auth` → token/စကားဝှက် မပါဘဲ non-loopback bind လုပ်ရန် ကြိုးပမ်းခြင်း။
- `another gateway instance is already listening` / `EADDRINUSE` → ပို့တ် အပြိုင်အဆိုင် ဖြစ်ခြင်း။

ဆက်စပ်–

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## ချန်နယ် ချိတ်ဆက်ပြီးသား ဖြစ်သော်လည်း မက်ဆေ့ချ် မစီးဆင်းခြင်း

ချန်နယ်အခြေအနေသည် connected ဖြစ်နေသော်လည်း မက်ဆေ့ချ် စီးဆင်းမှု မရှိပါက policy၊ ခွင့်ပြုချက်များနှင့် ချန်နယ်အလိုက် ပို့ဆောင်မှု စည်းမျဉ်းများကို အာရုံစိုက်ပါ။

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

ကြည့်ရှုရန်–

- DM policy (`pairing`, `allowlist`, `open`, `disabled`)။
- အုပ်စု allowlist နှင့် mention လိုအပ်ချက်များ။
- ချန်နယ် API ခွင့်ပြုချက်/စကုပ်များ မရှိခြင်း။

ပုံမှန်တွေ့ရသော လက္ခဏာများ–

- `mention required` → အုပ်စု mention policy ကြောင့် မက်ဆေ့ချ်ကို လျစ်လျူရှုထားသည်။
- `pairing` / အတည်ပြုချက် စောင့်ဆိုင်း အမှတ်အသားများ → ပို့သူကို အတည်မပြုရသေးခြင်း။
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → ချန်နယ် auth/permissions ပြဿနာ။

ဆက်စပ်–

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron နှင့် heartbeat ပို့ဆောင်မှု

cron သို့မဟုတ် heartbeat မလုပ်ဆောင်ခဲ့ပါက၊ သို့မဟုတ် ပို့ဆောင်မှု မရခဲ့ပါက scheduler အခြေအနေကို အရင်စစ်ပြီးနောက် ပို့ဆောင်မည့် ပစ်မှတ်ကို စစ်ဆေးပါ။

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

ကြည့်ရှုရန်–

- Cron ဖွင့်ထားခြင်းနှင့် နောက်တစ်ကြိမ် wake အချိန် ရှိနေခြင်း။
- အလုပ် run မှတ်တမ်း အခြေအနေ (`ok`, `skipped`, `error`)။
- Heartbeat ကျော်သွားရသည့် အကြောင်းရင်းများ (`quiet-hours`, `requests-in-flight`, `alerts-disabled`)။

ပုံမှန်တွေ့ရသော လက္ခဏာများ–

- `cron: scheduler disabled; jobs will not run automatically` → cron ပိတ်ထားခြင်း။
- `cron: timer tick failed` → scheduler tick မအောင်မြင်ခြင်း; ဖိုင်/လော့ဂ်/runtime အမှားများကို စစ်ဆေးပါ။
- `heartbeat skipped` နှင့် `reason=quiet-hours` → active hours အချိန်အကန့်အသတ် ပြင်ပတွင် ရှိနေခြင်း။
- `heartbeat: unknown accountId` → heartbeat ပို့ဆောင်မှု ပစ်မှတ်အတွက် account id မမှန်ကန်ခြင်း။

ဆက်စပ်–

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Node ကို pair လုပ်ထားသော်လည်း tool မအောင်မြင်ခြင်း

node ကို pair လုပ်ပြီးသားဖြစ်သော်လည်း tool မအောင်မြင်ပါက foreground၊ ခွင့်ပြုချက်နှင့် အတည်ပြုချက် အခြေအနေများကို ခွဲခြားစစ်ဆေးပါ။

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

ကြည့်ရှုရန်–

- မျှော်မှန်းထားသော စွမ်းဆောင်ရည်များနှင့်အတူ Node အွန်လိုင်း ဖြစ်နေခြင်း။
- ကင်မရာ/မိုက်/တည်နေရာ/စခရင် အတွက် OS ခွင့်ပြုချက်များ။
- Exec approvals နှင့် allowlist အခြေအနေ။

ပုံမှန်တွေ့ရသော လက္ခဏာများ–

- `NODE_BACKGROUND_UNAVAILABLE` → node အက်ပ်ကို foreground တွင် ရှိရမည်။
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → OS ခွင့်ပြုချက် မရှိခြင်း။
- `SYSTEM_RUN_DENIED: approval required` → exec အတည်ပြုချက် စောင့်ဆိုင်းနေခြင်း။
- `SYSTEM_RUN_DENIED: allowlist miss` → allowlist ကြောင့် အမိန့်ကို ပိတ်ဆို့ထားခြင်း။

ဆက်စပ်–

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Browser tool မအောင်မြင်ခြင်း

Gateway ကိုယ်တိုင် ကျန်းမာနေသော်လည်း browser tool လုပ်ဆောင်ချက်များ မအောင်မြင်ပါက ဒီအပိုင်းကို အသုံးပြုပါ။

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

ကြည့်ရှုရန်–

- မှန်ကန်သော browser executable လမ်းကြောင်း။
- CDP profile သို့ ရောက်နိုင်ခြင်း။
- `profile="chrome"` အတွက် extension relay tab ချိတ်ဆက်ထားခြင်း။

ပုံမှန်တွေ့ရသော လက္ခဏာများ–

- `Failed to start Chrome CDP on port` → browser process ကို စတင်မနိုင်ခြင်း။
- `browser.executablePath not found` → သတ်မှတ်ထားသော လမ်းကြောင်း မမှန်ကန်ခြင်း။
- `Chrome extension relay is running, but no tab is connected` → extension relay မချိတ်ဆက်ထားခြင်း။
- `Browser attachOnly is enabled ... not reachable` → attach-only profile တွင် ရောက်ရှိနိုင်သော target မရှိပါ။

ဆက်စပ်–

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## အဆင့်မြှင့်ပြီးနောက် ရုတ်တရက် ပြဿနာဖြစ်ပေါ်လာပါက

အဆင့်မြှင့်ပြီးနောက် ဖြစ်ပေါ်သော ပြဿနာအများစုသည် config drift သို့မဟုတ် ယခုအချိန်တွင် ပိုမိုတင်းကျပ်စွာ သတ်မှတ်ထားသော default များကို အကောင်အထည်ဖော်လိုက်ခြင်းကြောင့် ဖြစ်တတ်သည်။

### 1. Auth နှင့် URL override အပြုအမူ ပြောင်းလဲခဲ့သည်

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

စစ်ဆေးရန်–

- `gateway.mode=remote` ဖြစ်ပါက၊ CLI ခေါ်ဆိုမှုများသည် remote ကို ပစ်မှတ်ထားနေနိုင်ပြီး သင့် local ဝန်ဆောင်မှုကောင်းမွန်နေပါလိမ့်မည်။
- တိတိကျကျ `--url` ခေါ်ဆိုမှုများသည် သိမ်းဆည်းထားသော credential များသို့ အလိုအလျောက် ပြန်မကျော်ပါ။

ပုံမှန်တွေ့ရသော လက္ခဏာများ–

- `gateway connect failed:` → URL ပစ်မှတ် မှားယွင်းခြင်း။
- `unauthorized` → endpoint သို့ ရောက်နိုင်သော်လည်း auth မမှန်ကန်ခြင်း။

### 2. Bind နှင့် auth guardrails များ ပိုမိုတင်းကျပ်လာသည်

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

စစ်ဆေးရန်–

- Non-loopback bind များ (`lan`, `tailnet`, `custom`) သည် auth ကို ဖွဲ့စည်းထားရန် လိုအပ်သည်။
- `gateway.token` ကဲ့သို့သော အဟောင်း key များသည် `gateway.auth.token` ကို အစားထိုးမလုပ်နိုင်ပါ။

ပုံမှန်တွေ့ရသော လက္ခဏာများ–

- `refusing to bind gateway ... without auth` → bind + auth မကိုက်ညီခြင်း။
- runtime လည်ပတ်နေစဉ် `RPC probe: failed` → Gateway သက်ရှိနေသော်လည်း လက်ရှိ auth/URL ဖြင့် မရောက်နိုင်ခြင်း။

### 3. Pairing နှင့် device identity အခြေအနေ ပြောင်းလဲခဲ့သည်

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

စစ်ဆေးရန်–

- dashboard/nodes အတွက် device အတည်ပြုချက်များ စောင့်ဆိုင်းနေခြင်း။
- policy သို့မဟုတ် identity ပြောင်းလဲပြီးနောက် DM pairing အတည်ပြုချက်များ စောင့်ဆိုင်းနေခြင်း။

ပုံမှန်တွေ့ရသော လက္ခဏာများ–

- `device identity required` → device auth မပြည့်စုံခြင်း။
- `pairing required` → ပို့သူ/စက်ပစ္စည်းကို အတည်ပြုရမည်။

စစ်ဆေးပြီးနောက် ဝန်ဆောင်မှု ဖွဲ့စည်းပြင်ဆင်မှုနှင့် runtime တို့ မကိုက်ညီသေးပါက၊ တူညီသော profile/state directory မှ ဝန်ဆောင်မှု metadata ကို ပြန်လည်တပ်ဆင်ပါ–

```bash
openclaw gateway install --force
openclaw gateway restart
```

ဆက်စပ်–

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
