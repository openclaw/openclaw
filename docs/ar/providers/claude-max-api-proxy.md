---
summary: "استخدام اشتراك Claude Max/Pro كنقطة نهاية API متوافقة مع OpenAI"
read_when:
  - تريد استخدام اشتراك Claude Max مع أدوات متوافقة مع OpenAI
  - تريد خادم API محليًا يغلّف Claude Code CLI
  - تريد توفير المال باستخدام الاشتراك بدل مفاتيح API
title: "وكيل API لـ Claude Max"
---

# وكيل API لـ Claude Max

**claude-max-api-proxy** هي أداة مجتمعية تكشف اشتراك Claude Max/Pro الخاص بك كنقطة نهاية API متوافقة مع OpenAI. يتيح لك ذلك استخدام اشتراكك مع أي أداة تدعم صيغة OpenAI API.

## لماذا نستخدم هذا؟

| النهج               | التكلفة                                                                                                            | الأنسب لـ                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| واجهة Anthropic API | الدفع لكل رمز (~15 دولارًا لكل مليون إدخال، 75 دولارًا لكل مليون إخراج لـ Opus) | تطبيقات الإنتاج، أحجام عالية                 |
| اشتراك Claude Max   | 200 دولار شهريًا بسعر ثابت                                                                                         | الاستخدام الشخصي، التطوير، استخدام غير محدود |

إذا كان لديك اشتراك Claude Max وترغب في استخدامه مع أدوات متوافقة مع OpenAI، فيمكن لهذا الوكيل أن يوفر عليك مبلغًا كبيرًا.

## كيف يعمل

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

يقوم الوكيل بما يلي:

1. يستقبل طلبات بصيغة OpenAI على `http://localhost:3456/v1/chat/completions`
2. يحوّلها إلى أوامر Claude Code CLI
3. يعيد الاستجابات بصيغة OpenAI (مع دعم البثّ)

## التثبيت

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## الاستخدام

### بدء الخادم

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### اختباره

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

### مع OpenClaw

يمكنك توجيه OpenClaw إلى الوكيل كنقطة نهاية مخصصة متوافقة مع OpenAI:

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

## النماذج المتاحة

| معرف النموذج      | الخرائط إلى     |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## التشغيل التلقائي على macOS

أنشئ LaunchAgent لتشغيل الوكيل تلقائيًا:

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

## الروابط

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **المشكلات:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## ملاحظات

- هذه **أداة مجتمعية** وليست مدعومة رسميًا من Anthropic أو OpenClaw
- تتطلب اشتراكًا نشطًا في Claude Max/Pro مع مصادقة Claude Code CLI
- يعمل الوكيل محليًا ولا يرسل البيانات إلى أي خوادم طرف ثالث
- استجابات البثّ مدعومة بالكامل

## انظر أيضًا

- [موفّر Anthropic](/providers/anthropic) — تكامل OpenClaw أصلي مع إعداد setup-token أو مفاتيح API
- [موفّر OpenAI](/providers/openai) — لاشتراكات OpenAI/Codex
