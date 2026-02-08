---
summary: "`openclaw plugins` အတွက် CLI ကိုးကားချက် (စာရင်းပြုစုခြင်း၊ ထည့်သွင်းခြင်း၊ ဖွင့်/ပိတ်၊ doctor)"
read_when:
  - in-process Gateway ပလပ်ဂင်များကို ထည့်သွင်း သို့မဟုတ် စီမံခန့်ခွဲလိုသည့်အခါ
  - ပလပ်ဂင် တင်သွင်းမှု မအောင်မြင်သည့် ပြဿနာများကို ဒီဘဂ်လုပ်လိုသည့်အခါ
title: "ပလပ်ဂင်များ"
x-i18n:
  source_path: cli/plugins.md
  source_hash: 60476e0a9b7247bd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:06Z
---

# `openclaw plugins`

Gateway（ဂိတ်ဝေး） ပလပ်ဂင်/တိုးချဲ့မှုများကို စီမံခန့်ခွဲရန် (in-process အဖြစ် တင်သွင်းထားသည်)။

ဆက်စပ်အကြောင်းအရာများ—

- Plugin system: [Plugins](/tools/plugin)
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)
- Security hardening: [Security](/gateway/security)

## Commands

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

OpenClaw နှင့်အတူ ပါဝင်လာသော bundled plugins များသည် ပုံမှန်အားဖြင့် ပိတ်ထားပြီး စတင်သည်။ ၎င်းတို့ကို အသက်သွင်းရန် `plugins enable` ကို အသုံးပြုပါ။

ပလပ်ဂင်တိုင်းတွင် inline JSON Schema ပါဝင်သည့် `openclaw.plugin.json` ဖိုင်တစ်ခု ရှိရမည် (`configSchema`, အလွတ်ဖြစ်နေသော်လည်း)။ manifest သို့မဟုတ် schema မရှိခြင်း/မမှန်ကန်ခြင်းများကြောင့် ပလပ်ဂင်ကို မတင်သွင်းနိုင်ဘဲ config အတည်ပြုခြင်း မအောင်မြင်နိုင်ပါသည်။

### Install

```bash
openclaw plugins install <path-or-spec>
```

လုံခြုံရေး သတိပေးချက်—ပလပ်ဂင် ထည့်သွင်းခြင်းကို ကိုဒ်ကို chạy လုပ်သကဲ့သို့ စဉ်းစားပါ။ pinned versions ကို ဦးစားပေးအသုံးပြုပါ။

ပံ့ပိုးထားသော archive များ—`.zip`, `.tgz`, `.tar.gz`, `.tar`။

local directory ကို ကူးယူခြင်း မလုပ်ဘဲ ရှောင်ရှားရန် `--link` ကို အသုံးပြုပါ (`plugins.load.paths` ထဲသို့ ထည့်ပေါင်းသည်)—

```bash
openclaw plugins install -l ./my-plugin
```

### Update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Update များသည် npm မှ ထည့်သွင်းထားသော ပလပ်ဂင်များအတွက်သာ သက်ရောက်သည် (`plugins.installs` တွင် ခြေရာခံထားသည်)။
