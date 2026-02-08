---
summary: "IDE ပေါင်းစည်းမှုများအတွက် ACP bridge ကို လည်ပတ်စေခြင်း"
read_when:
  - ACP အခြေပြု IDE ပေါင်းစည်းမှုများကို တပ်ဆင်ချိန်
  - Gateway သို့ ACP ဆက်ရှင် လမ်းကြောင်းပြမှုကို ဒီဘဂ်လုပ်ချိန်
title: "acp"
x-i18n:
  source_path: cli/acp.md
  source_hash: 0c09844297da250b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:06Z
---

# acp

OpenClaw Gateway တစ်ခုနှင့် ဆက်သွယ်သော ACP (Agent Client Protocol) bridge ကို လည်ပတ်စေသည်။

ဤအမိန့်သည် IDE များအတွက် stdio မှတဆင့် ACP ကို ပြောဆိုပြီး Prompts များကို WebSocket မှတဆင့် Gateway（ဂိတ်ဝေး）သို့ ပို့ဆောင်သည်။ ACP ဆက်ရှင်များကို Gateway ဆက်ရှင် ကီးများနှင့် ကိုက်ညီအောင် ထိန်းသိမ်းထားသည်။

## Usage

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## ACP client (debug)

IDE မလိုအပ်ဘဲ bridge ကို စစ်ဆေးရန် built-in ACP client ကို အသုံးပြုပါ။
၎င်းသည် ACP bridge ကို ဖွင့်ပြီး Prompts များကို အပြန်အလှန် ရိုက်ထည့်နိုင်စေသည်။

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## How to use this

IDE (သို့မဟုတ် အခြား client) တစ်ခုက Agent Client Protocol ကို ပြောဆိုပြီး OpenClaw Gateway ဆက်ရှင်ကို မောင်းနှင်စေလိုပါက ACP ကို အသုံးပြုပါ။

1. Gateway（ဂိတ်ဝေး） ကို လည်ပတ်နေကြောင်း သေချာပါစေ (local သို့မဟုတ် remote)။
2. Gateway ဦးတည်ရာကို (config သို့မဟုတ် flags ဖြင့်) ဖွဲ့စည်းပြင်ဆင်ပါ။
3. သင့် IDE ကို stdio မှတဆင့် `openclaw acp` ကို လည်ပတ်စေရန် ညွှန်ကြားပါ။

ဥပမာ config (သိမ်းဆည်းထားသည်):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

ဥပမာ တိုက်ရိုက် လည်ပတ်ခြင်း (config မရေးပါ):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selecting agents

ACP သည် agent များကို တိုက်ရိုက် မရွေးချယ်ပါ။ Gateway ဆက်ရှင် ကီးဖြင့် လမ်းကြောင်းပြုလုပ်သည်။

သတ်မှတ်ထားသော agent ကို ဦးတည်ရန် agent-အလိုက် ဆက်ရှင် ကီးများကို အသုံးပြုပါ:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

ACP ဆက်ရှင်တစ်ခုစီသည် Gateway ဆက်ရှင် ကီးတစ်ခုနှင့် ကိုက်ညီပါသည်။ Agent တစ်ခုတွင် ဆက်ရှင်များ အများအပြား ရှိနိုင်ပြီး၊ ACP သည် သင် ကီး သို့မဟုတ် label ကို မပြောင်းလဲပါက သီးခြားထားသော `acp:<uuid>` ဆက်ရှင်ကို မူလအနေဖြင့် အသုံးပြုပါသည်။

## Zed editor setup

`~/.config/zed/settings.json` တွင် custom ACP agent တစ်ခုကို ထည့်ပါ (သို့မဟုတ် Zed ၏ Settings UI ကို အသုံးပြုပါ):

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Gateway သို့မဟုတ် agent တစ်ခုကို သတ်မှတ်ရန်:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

Zed တွင် Agent panel ကို ဖွင့်ပြီး “OpenClaw ACP” ကို ရွေးချယ်ကာ thread တစ်ခုကို စတင်ပါ။

## Session mapping

မူလအနေဖြင့် ACP ဆက်ရှင်များသည် `acp:` prefix ပါသော သီးခြား Gateway ဆက်ရှင် ကီးကို ရရှိပါသည်။
သိရှိပြီးသား ဆက်ရှင်ကို ပြန်အသုံးပြုရန် ဆက်ရှင် ကီး သို့မဟုတ် label ကို ပေးပါ:

- `--session <key>`: သတ်မှတ်ထားသော Gateway ဆက်ရှင် ကီးကို အသုံးပြုပါ။
- `--session-label <label>`: label ဖြင့် ရှိပြီးသား ဆက်ရှင်ကို ရှာဖွေသတ်မှတ်ပါ။
- `--reset-session`: ထိုကီးအတွက် ဆက်ရှင် id အသစ်တစ်ခုကို ဖန်တီးပါ (ကီးတူ၊ transcript အသစ်)။

သင့် ACP client သည် metadata ကို ထောက်ပံ့ပါက ဆက်ရှင်တစ်ခုချင်းစီအလိုက် override ပြုလုပ်နိုင်ပါသည်:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

ဆက်ရှင် ကီးများအကြောင်း ပိုမိုလေ့လာရန် [/concepts/session](/concepts/session) တွင် ကြည့်ပါ။

## Options

- `--url <url>`: Gateway WebSocket URL (config ပြုလုပ်ထားပါက gateway.remote.url ကို မူလအဖြစ် အသုံးပြုသည်)။
- `--token <token>`: Gateway အတည်ပြု token။
- `--password <password>`: Gateway အတည်ပြု စကားဝှက်။
- `--session <key>`: မူလ ဆက်ရှင် ကီး။
- `--session-label <label>`: ဖြေရှင်းရန် မူလ ဆက်ရှင် label။
- `--require-existing`: ဆက်ရှင် ကီး/label မရှိပါက မအောင်မြင်စေရန်။
- `--reset-session`: ပထမဆုံး အသုံးမပြုမီ ဆက်ရှင် ကီးကို ပြန်လည်သတ်မှတ်ရန်။
- `--no-prefix-cwd`: အလုပ်လုပ်နေသော directory ဖြင့် prompts ကို prefix မထည့်ရန်။
- `--verbose, -v`: stderr သို့ အသေးစိတ် log ထုတ်ရန်။

### `acp client` options

- `--cwd <dir>`: ACP ဆက်ရှင်အတွက် အလုပ်လုပ်ရာ directory။
- `--server <command>`: ACP server အမိန့် (မူလ: `openclaw`)။
- `--server-args <args...>`: ACP server သို့ ပေးပို့သော အပို arguments။
- `--server-verbose`: ACP server တွင် အသေးစိတ် logging ကို ဖွင့်ရန်။
- `--verbose, -v`: client ဘက် အသေးစိတ် logging။
