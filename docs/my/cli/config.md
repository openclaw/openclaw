---
summary: "`openclaw config` အတွက် CLI ကိုးကားလမ်းညွှန် (config တန်ဖိုးများကို get/set/unset ပြုလုပ်ရန်)"
read_when:
  - config ကို အပြန်အလှန်မပါဘဲ ဖတ်ရှုရန် သို့မဟုတ် တည်းဖြတ်ရန် လိုအပ်သောအခါ
title: "config"
x-i18n:
  source_path: cli/config.md
  source_hash: d60a35f5330f22bc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:59Z
---

# `openclaw config`

Config အထောက်အကူများ — လမ်းကြောင်းအလိုက် တန်ဖိုးများကို get/set/unset ပြုလုပ်နိုင်သည်။ Subcommand မပါဘဲ အမိန့်ကို chạy လုပ်ပါက
configure wizard ကို ဖွင့်ပေးမည် ( `openclaw configure` နှင့် တူညီသည်)။

## Examples

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Paths

Paths များတွင် dot သို့မဟုတ် bracket notation ကို အသုံးပြုသည်—

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

အထူး အေးဂျင့်တစ်ခုကို ရည်ရွယ်ရန် agent စာရင်း၏ index ကို အသုံးပြုပါ—

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

တန်ဖိုးများကို ဖြစ်နိုင်သမျှ JSON5 အဖြစ် parse လုပ်မည်ဖြစ်ပြီး မဖြစ်ပါက string အဖြစ် ဆက်ဆံပါမည်။
JSON5 parse လုပ်ရန် မဖြစ်မနေလိုအပ်ပါက `--json` ကို အသုံးပြုပါ။

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

တည်းဖြတ်ပြီးနောက် Gateway（ဂိတ်ဝေး）ကို ပြန်လည်စတင်ပါ။
