---
summary: "`openclaw update` အတွက် CLI ကိုးကားချက် (အရင်းအမြစ်ကို လုံခြုံစွာ အပ်ဒိတ်လုပ်ခြင်း + Gateway ကို အလိုအလျောက် ပြန်စတင်ခြင်း)"
read_when:
  - အရင်းအမြစ် checkout ကို လုံခြုံစွာ အပ်ဒိတ်လုပ်ချင်သောအခါ
  - "`--update` shorthand ၏ အပြုအမူကို နားလည်ရန် လိုအပ်သောအခါ"
title: "update"
---

# `openclaw update`

OpenClaw ကို လုံခြုံစွာ အပ်ဒိတ်လုပ်ပြီး stable/beta/dev ချန်နယ်များအကြား ပြောင်းလဲနိုင်သည်။

**npm/pnpm** ဖြင့် ထည့်သွင်းထားပါက (global install၊ git metadata မရှိပါက) အပ်ဒိတ်လုပ်ခြင်းသည် [Updating](/install/updating) တွင် ဖော်ပြထားသည့် package manager လုပ်ငန်းစဉ်အတိုင်း ဖြစ်ပါသည်။

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: အပ်ဒိတ်အောင်မြင်ပြီးနောက် Gateway ဝန်ဆောင်မှုကို ပြန်မစတင်ဘဲ ကျော်သွားရန်။
- `--channel <stable|beta|dev>`: အပ်ဒိတ် ချန်နယ်ကို သတ်မှတ်ရန် (git + npm; config တွင် သိမ်းဆည်းထားသည်)။
- `--tag <dist-tag|version>`: ယခုအပ်ဒိတ်အတွက်သာ npm dist-tag သို့မဟုတ် ဗားရှင်းကို အစားထိုးသတ်မှတ်ရန်။
- `--json`: စက်ဖတ်ရှုနိုင်သော `UpdateRunResult` JSON ကို ပရင့်ထုတ်ရန်။
- `--timeout <seconds>`: အဆင့်တစ်ဆင့်ချင်းအတွက် timeout (မူလတန်ဖိုး 1200s)။

မှတ်ချက်: downgrade လုပ်ရန် အတည်ပြုချက် လိုအပ်ပါသည်၊ အကြောင်းမှာ ဗားရှင်းအဟောင်းများသည် ဖွဲ့စည်းပြင်ဆင်မှုကို ပျက်စီးစေနိုင်ပါသည်။

## `update status`

လက်ရှိ အသုံးပြုနေသော အပ်ဒိတ် ချန်နယ်နှင့် git tag/branch/SHA (source checkout များအတွက်) ကို ပြသပြီး အပ်ဒိတ် ရရှိနိုင်မှုကို ဖော်ပြပါသည်။

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: စက်ဖတ်ရှုနိုင်သော အခြေအနေ JSON ကို ပရင့်ထုတ်ရန်။
- `--timeout <seconds>`: စစ်ဆေးမှုများအတွက် timeout (မူလတန်ဖိုး 3s)။

## `update wizard`

Update channel တစ်ခုကို ရွေးချယ်ပြီး update ပြီးနောက် Gateway ကို restart လုပ်မလုပ် အတည်ပြုရန် interactive flow (default သည် restart လုပ်ခြင်း)။ `dev` ကို ရွေးချယ်ပြီး git checkout မရှိပါက ၎င်းကို ဖန်တီးရန် ကမ်းလှမ်းပါသည်။

## What it does

ချန်နယ်ကို တိတိကျကျ ပြောင်းလဲသတ်မှတ်ပါက (`--channel ...`)၊ OpenClaw သည် ထည့်သွင်းနည်းကိုလည်း ကိုက်ညီအောင် ထိန်းသိမ်းပါသည်—

- `dev` → git checkout ကို သေချာစေပါသည် (မူလ: `~/openclaw`၊ `OPENCLAW_GIT_DIR` ဖြင့် override လုပ်နိုင်သည်)၊ ၎င်းကို အပ်ဒိတ်လုပ်ပြီး ထို checkout မှ global CLI ကို ထည့်သွင်းပါသည်။
- `stable`/`beta` → ကိုက်ညီသော dist-tag ဖြင့် npm မှ ထည့်သွင်းပါသည်။

## Git checkout flow

Channels:

- `stable`: နောက်ဆုံး non-beta tag ကို checkout လုပ်ပြီး build + doctor ကို လုပ်ဆောင်ပါသည်။
- `beta`: နောက်ဆုံး `-beta` tag ကို checkout လုပ်ပြီး build + doctor ကို လုပ်ဆောင်ပါသည်။
- `dev`: `main` ကို checkout လုပ်ပြီး fetch + rebase ကို လုပ်ဆောင်ပါသည်။

High-level:

1. worktree သန့်ရှင်းရပါမည် (uncommitted changes မရှိရ)။
2. ရွေးချယ်ထားသော ချန်နယ် (tag သို့မဟုတ် branch) သို့ ပြောင်းပါသည်။
3. upstream ကို fetch လုပ်ပါသည် (dev အတွက်သာ)။
4. dev အတွက်သာ: temp worktree တစ်ခုတွင် preflight lint + TypeScript build ကို လုပ်ဆောင်ပါသည်; tip သည် မအောင်မြင်ပါက build သန့်ရှင်းသော နောက်ဆုံး commit ကို ရှာဖွေရန် commit 10 ခုအထိ နောက်ပြန်သွားပါသည်။
5. ရွေးချယ်ထားသော commit သို့ rebase လုပ်ပါသည် (dev အတွက်သာ)။
6. deps များကို ထည့်သွင်းပါသည် (pnpm ကို ဦးစားပေးပြီး npm ကို fallback အဖြစ် သုံးပါသည်)။
7. Build လုပ်ပြီး Control UI ကို build လုပ်ပါသည်။
8. နောက်ဆုံး “safe update” စစ်ဆေးမှုအဖြစ် `openclaw doctor` ကို လုပ်ဆောင်ပါသည်။
9. plugin များကို လက်ရှိ ချန်နယ်နှင့် ကိုက်ညီအောင် sync လုပ်ပါသည် (dev သည် bundled extensions ကို သုံးပြီး stable/beta သည် npm ကို သုံးပါသည်) နှင့် npm ဖြင့် ထည့်သွင်းထားသော plugin များကို အပ်ဒိတ်လုပ်ပါသည်။

## `--update` shorthand

`openclaw --update` သည် `openclaw update` သို့ rewrite လုပ်ပေးပါသည် (shell များနှင့် launcher script များအတွက် အသုံးဝင်ပါသည်)။

## See also

- `openclaw doctor` (git checkout များတွင် update ကို အရင် လုပ်ဆောင်ရန် အကြံပြုပါသည်)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
