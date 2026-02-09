---
summary: "Claude Max/Pro စာရင်းသွင်းမှုကို OpenAI နှင့် ကိုက်ညီသော API endpoint အဖြစ် အသုံးပြုရန်"
read_when:
  - OpenAI နှင့် ကိုက်ညီသော ကိရိယာများနှင့် Claude Max စာရင်းသွင်းမှုကို အသုံးပြုလိုသောအခါ
  - Claude Code CLI ကို ခေါက်ပတ်ထားသော local API server တစ်ခုကို အသုံးပြုလိုသောအခါ
  - API key များအစား စာရင်းသွင်းမှုကို အသုံးပြုပြီး ကုန်ကျစရိတ် ချွေတာလိုသောအခါ
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy** သည် သင်၏ Claude Max/Pro subscription ကို OpenAI-compatible API endpoint အဖြစ် ဖွင့်ပေးသော community tool တစ်ခုဖြစ်သည်။ ၎င်းကြောင့် OpenAI API format ကို ထောက်ပံ့သော မည်သည့် tool မဆိုနှင့် သင်၏ subscription ကို အသုံးပြုနိုင်ပါသည်။

## ဘာကြောင့် အသုံးပြုသင့်သလဲ?

| နည်းလမ်း                  | ကုန်ကျစရိတ်                                                                                    | အကောင်းဆုံး အသုံးပြုရန်                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Anthropic API             | token အလိုက် ပေးချေ (~$15/M input, Opus အတွက် $75/M output) | Production အက်ပ်များ၊ အသုံးပြုမှု အမြင့်                       |
| Claude Max စာရင်းသွင်းမှု | လစဉ် $200 တည်းဟူသော တစ်ပြားတည်း                                                                | ကိုယ်ပိုင်အသုံးပြုမှု၊ ဖွံ့ဖြိုးရေး၊ အကန့်အသတ်မရှိ အသုံးပြုမှု |

Claude Max စာရင်းသွင်းမှု ရှိပြီး OpenAI နှင့် ကိုက်ညီသော ကိရိယာများနှင့် အသုံးပြုလိုပါက၊ ဤ proxy သည် အရေးပါသော ကုန်ကျစရိတ် ချွေတာမှုကို ပေးစွမ်းနိုင်ပါသည်။

## အလုပ်လုပ်ပုံ

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

ဤ proxy သည်—

1. `http://localhost:3456/v1/chat/completions` တွင် OpenAI ဖော်မတ်ဖြင့် တောင်းဆိုမှုများကို လက်ခံပါသည်
2. ၎င်းတို့ကို Claude Code CLI အမိန့်များအဖြစ် ပြောင်းလဲပါသည်
3. OpenAI ဖော်မတ်ဖြင့် အဖြေများကို ပြန်လည်ပေးပို့ပါသည် (streaming ကို ပံ့ပိုးပါသည်)

## ထည့်သွင်းတပ်ဆင်ခြင်း

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## အသုံးပြုနည်း

### ဆာဗာကို စတင်ပါ

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### စမ်းသပ်ပါ

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### OpenClaw နှင့်အတူ

OpenClaw ကို custom OpenAI နှင့် ကိုက်ညီသော endpoint အဖြစ် proxy သို့ ညွှန်ပြနိုင်ပါသည်—

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:3456/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-opus-4" },
    },
  },
}
```

## ရရှိနိုင်သော မော်ဒယ်များ

| Model ID          | ချိတ်ဆက်ထားသော မော်ဒယ် |
| ----------------- | ---------------------- |
| `claude-opus-4`   | Claude Opus 4          |
| `claude-sonnet-4` | Claude Sonnet 4        |
| `claude-haiku-4`  | Claude Haiku 4         |

## macOS တွင် အလိုအလျောက် စတင်ခြင်း

proxy ကို အလိုအလျောက် လည်ပတ်စေရန် LaunchAgent တစ်ခုကို ဖန်တီးပါ—

```bash
cat > ~/Library/LaunchAgents/com.claude-max-api.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-max-api</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-api.plist
```

## လင့်ခ်များ

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## မှတ်ချက်များ

- ဤသည်မှာ **community tool** တစ်ခုဖြစ်ပြီး Anthropic သို့မဟုတ် OpenClaw မှ တရားဝင် ပံ့ပိုးထားခြင်း မရှိပါ
- Claude Code CLI ဖြင့် အတည်ပြုထားသော Claude Max/Pro စာရင်းသွင်းမှု တစ်ခု လိုအပ်ပါသည်
- proxy သည် local တွင်သာ လည်ပတ်ပြီး တတိယပါတီ ဆာဗာများသို့ ဒေတာ မပို့ပါ
- Streaming အဖြေများကို အပြည့်အဝ ပံ့ပိုးထားပါသည်

## ဆက်လက်ကြည့်ရှုရန်

- [Anthropic provider](/providers/anthropic) - setup-token သို့မဟုတ် API key များဖြင့် Claude ကို Native OpenClaw ဖြင့် ချိတ်ဆက်အသုံးပြုခြင်း
- [OpenAI provider](/providers/openai) - OpenAI/Codex စာရင်းသွင်းမှုများအတွက်
