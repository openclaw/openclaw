---
title: Sandbox CLI
summary: "sandbox ကွန်တိန်နာများကို စီမံခန့်ခွဲခြင်းနှင့် အကျိုးသက်ရောက်နေသော sandbox မူဝါဒကို စစ်ဆေးခြင်း"
read_when: "သင်သည် sandbox ကွန်တိန်နာများကို စီမံခန့်ခွဲနေစဉ် သို့မဟုတ် sandbox/tool-policy အပြုအမူကို အမှားရှာဖွေနေစဉ်"
status: active
---

# Sandbox CLI

ခွဲခြားထားသော agent အကောင်အထည်ဖော်မှုအတွက် Docker အခြေပြု sandbox ကွန်တိန်နာများကို စီမံခန့်ခွဲပါ။

## Overview

OpenClaw သည် လုံခြုံရေးအတွက် agent များကို isolated Docker container များအတွင်း လည်ပတ်နိုင်ပါသည်။ `sandbox` command များသည် update သို့မဟုတ် configuration ပြောင်းလဲမှုများပြီးနောက် အထူးသဖြင့် container များကို စီမံခန့်ခွဲရန် ကူညီပါသည်။

## Commands

### `openclaw sandbox explain`

**အကျိုးသက်ရောက်နေသော** sandbox mode/scope/workspace ဝင်ရောက်ခွင့်၊ sandbox tool မူဝါဒနှင့် မြှင့်တင်ထားသော gates များကို (fix-it config key လမ်းကြောင်းများနှင့်အတူ) စစ်ဆေးပါ။

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

sandbox ကွန်တိန်နာအားလုံးကို ၎င်းတို့၏ အခြေအနေနှင့် ဖွဲ့စည်းပြင်ဆင်မှုနှင့်အတူ စာရင်းပြုစုပါ။

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Output တွင် ပါဝင်သည်များမှာ —**

- ကွန်တိန်နာ အမည်နှင့် အခြေအနေ (running/stopped)
- Docker image နှင့် config နှင့် ကိုက်ညီမှုရှိ/မရှိ
- အသက် (ဖန်တီးပြီးကတည်းက ကြာချိန်)
- Idle အချိန် (နောက်ဆုံး အသုံးပြုပြီးကတည်းက ကြာချိန်)
- ဆက်စပ်နေသော session/agent

### `openclaw sandbox recreate`

အပ်ဒိတ်လုပ်ထားသော image များ/ဖွဲ့စည်းပြင်ဆင်မှုများဖြင့် ပြန်လည်ဖန်တီးစေရန် sandbox ကွန်တိန်နာများကို ဖယ်ရှားပါ။

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Options:**

- `--all`: sandbox ကွန်တိန်နာအားလုံးကို ပြန်လည်ဖန်တီးရန်
- `--session <key>`: သတ်မှတ်ထားသော session အတွက် ကွန်တိန်နာကို ပြန်လည်ဖန်တီးရန်
- `--agent <id>`: သတ်မှတ်ထားသော agent အတွက် ကွန်တိန်နာများကို ပြန်လည်ဖန်တီးရန်
- `--browser`: browser ကွန်တိန်နာများကိုသာ ပြန်လည်ဖန်တီးရန်
- `--force`: အတည်ပြုမေးမြန်းမှုကို ကျော်လွှားရန်

**အရေးကြီးချက်:** agent ကို နောက်တစ်ကြိမ် အသုံးပြုသည့်အခါ ကွန်တိန်နာများကို အလိုအလျောက် ပြန်လည်ဖန်တီးပေးမည်ဖြစ်သည်။

## Use Cases

### Docker image များကို အပ်ဒိတ်လုပ်ပြီးနောက်

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### sandbox ဖွဲ့စည်းပြင်ဆင်မှု ပြောင်းလဲပြီးနောက်

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### setupCommand ကို ပြောင်းလဲပြီးနောက်

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### သတ်မှတ်ထားသော agent တစ်ခုအတွက်သာ

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Why is this needed?

**ပြဿနာ:** sandbox Docker image များ သို့မဟုတ် ဖွဲ့စည်းပြင်ဆင်မှုကို အပ်ဒိတ်လုပ်သည့်အခါ —

- ရှိပြီးသား ကွန်တိန်နာများသည် အဟောင်းဆက်တင်များဖြင့် ဆက်လက် လည်ပတ်နေသည်
- ကွန်တိန်နာများကို မလှုပ်ရှားမှု ၂၄ နာရီအကြာတွင်သာ prune လုပ်သည်
- ပုံမှန်အသုံးပြုနေသော agent များသည် အဟောင်းကွန်တိန်နာများကို အကန့်အသတ်မရှိ ဆက်လက် လည်ပတ်စေထားသည်

**Solution:** အဟောင်း container များကို အတင်းအကျပ် ဖယ်ရှားရန် `openclaw sandbox recreate` ကို အသုံးပြုပါ။ နောက်တစ်ကြိမ် လိုအပ်လာသောအခါ လက်ရှိ setting များဖြင့် အလိုအလျောက် ပြန်လည် ဖန်တီးပေးပါမည်။

Tip: manual `docker rm` ထက် `openclaw sandbox recreate` ကို ဦးစားပေးပါ။ ၎င်းသည် Gateway ၏ container naming ကို အသုံးပြုပြီး scope/session key များ ပြောင်းလဲသည့်အခါ mismatch ဖြစ်ခြင်းကို ရှောင်ရှားပေးပါသည်။

## Configuration

Sandbox ဆက်တင်များကို `agents.defaults.sandbox` အောက်ရှိ `~/.openclaw/openclaw.json` တွင် ထားရှိထားပါသည် (agent တစ်ခုချင်းစီအလိုက် override များကို `agents.list[].sandbox` တွင် ထားပါ):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## See Also

- [Sandbox Documentation](/gateway/sandboxing)
- [Agent Configuration](/concepts/agent-workspace)
- [Doctor Command](/gateway/doctor) - sandbox setup ကို စစ်ဆေးရန်
