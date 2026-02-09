---
summary: "Claude Max/Pro سبسکرپشن کو OpenAI-مطابقت رکھنے والے API اینڈپوائنٹ کے طور پر استعمال کریں"
read_when:
  - آپ OpenAI-مطابقت رکھنے والے اوزاروں کے ساتھ Claude Max سبسکرپشن استعمال کرنا چاہتے ہیں
  - آپ ایک مقامی API سرور چاہتے ہیں جو Claude Code CLI کو ریپ کرے
  - آپ API کیز کے بجائے سبسکرپشن استعمال کر کے پیسے بچانا چاہتے ہیں
title: "Claude Max API پراکسی"
---

# Claude Max API پراکسی

**claude-max-api-proxy** ایک کمیونٹی ٹول ہے جو آپ کی Claude Max/Pro سبسکرپشن کو OpenAI سے ہم آہنگ API اینڈپوائنٹ کے طور پر پیش کرتا ہے۔ اس سے آپ اپنی سبسکرپشن کو کسی بھی ایسے ٹول کے ساتھ استعمال کر سکتے ہیں جو OpenAI API فارمیٹ کو سپورٹ کرتا ہو۔

## کیوں استعمال کریں؟

| طریقہ               | لاگت                                                                                       | بہترین استعمال                          |
| ------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| Anthropic API       | فی ٹوکن ادائیگی (~$15/M ان پٹ، $75/M آؤٹ پٹ برائے Opus) | پروڈکشن ایپس، زیادہ حجم                 |
| Claude Max سبسکرپشن | $200/ماہ مقررہ                                                                             | ذاتی استعمال، ڈیولپمنٹ، لامحدود استعمال |

اگر آپ کے پاس Claude Max سبسکرپشن ہے اور آپ اسے OpenAI-مطابقت رکھنے والے اوزاروں کے ساتھ استعمال کرنا چاہتے ہیں، تو یہ پراکسی آپ کو خاطر خواہ رقم بچا سکتی ہے۔

## یہ کیسے کام کرتا ہے

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

پراکسی:

1. OpenAI-فارمیٹ کی درخواستیں `http://localhost:3456/v1/chat/completions` پر قبول کرتی ہے
2. انہیں Claude Code CLI کمانڈز میں تبدیل کرتی ہے
3. جوابات OpenAI فارمیٹ میں واپس کرتی ہے (اسٹریمنگ سپورٹ کے ساتھ)

## انسٹالیشن

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## استعمال

### سرور شروع کریں

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### جانچ کریں

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

### OpenClaw کے ساتھ

آپ OpenClaw کو ایک حسبِ ضرورت OpenAI-مطابقت رکھنے والے اینڈپوائنٹ کے طور پر اس پراکسی کی طرف پوائنٹ کر سکتے ہیں:

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

## دستیاب ماڈلز

| ماڈل ID           | میپ ہوتا ہے     |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOS پر خودکار آغاز

پراکسی کو خودکار طور پر چلانے کے لیے ایک LaunchAgent بنائیں:

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

## لنکس

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## نوٹس

- یہ ایک **کمیونٹی ٹول** ہے، جس کی Anthropic یا OpenClaw کی جانب سے باضابطہ سپورٹ نہیں
- Claude Code CLI کے ساتھ تصدیق شدہ فعال Claude Max/Pro سبسکرپشن درکار ہے
- پراکسی مقامی طور پر چلتی ہے اور کسی تیسرے فریق کے سرورز کو ڈیٹا نہیں بھیجتی
- اسٹریمنگ جوابات مکمل طور پر سپورٹڈ ہیں

## یہ بھی دیکھیں

- [Anthropic provider](/providers/anthropic) - setup-token یا API کیز کے ساتھ Claude کی نیٹو OpenClaw انٹیگریشن
- [OpenAI provider](/providers/openai) - OpenAI/Codex سبسکرپشنز کے لیے
