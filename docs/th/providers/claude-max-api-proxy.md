---
summary: "ใช้การสมัครสมาชิก Claude Max/Pro เป็นเอ็นด์พอยต์ API ที่เข้ากันได้กับ OpenAI"
read_when:
  - คุณต้องการใช้การสมัครสมาชิก Claude Max กับเครื่องมือที่รองรับ OpenAI
  - คุณต้องการเซิร์ฟเวอร์ API ภายในเครื่องที่ห่อหุ้ม Claude Code CLI
  - คุณต้องการประหยัดค่าใช้จ่ายโดยใช้การสมัครสมาชิกแทนคีย์ API
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy** เป็นเครื่องมือจากชุมชนที่เปิดเผยการสมัครสมาชิก Claude Max/Pro ของคุณเป็นเอ็นด์พอยต์ API ที่เข้ากันได้กับ OpenAI ซึ่งช่วยให้คุณสามารถใช้การสมัครสมาชิกกับเครื่องมือใดๆที่รองรับรูปแบบ OpenAI API ได้ 43. สิ่งนี้ช่วยให้คุณใช้การสมัครสมาชิกของคุณกับเครื่องมือใดก็ได้ที่รองรับรูปแบบ OpenAI API

## ทำไมต้องใช้สิ่งนี้?

| แนวทาง                    | ค่าใช้จ่าย                                                                                         | เหมาะสำหรับ                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Anthropic API             | คิดค่าบริการตามโทเคน (~$15/M อินพุต, $75/M เอาต์พุตสำหรับ Opus) | แอปใช้งานจริง, ปริมาณงานสูง                  |
| การสมัครสมาชิก Claude Max | $200/เดือน แบบเหมาจ่าย                                                                             | ใช้งานส่วนบุคคล, การพัฒนา, ใช้งานได้ไม่จำกัด |

หากคุณมีการสมัครสมาชิก Claude Max และต้องการใช้กับเครื่องมือที่เข้ากันได้กับ OpenAI พร็อกซีนี้สามารถช่วยประหยัดค่าใช้จ่ายได้อย่างมาก

## ทำงานอย่างไร

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

พร็อกซีจะ:

1. รับคำขอในรูปแบบ OpenAI ที่ `http://localhost:3456/v1/chat/completions`
2. แปลงเป็นคำสั่งของ Claude Code CLI
3. ส่งคืนคำตอบในรูปแบบ OpenAI (รองรับการสตรีม)

## การติดตั้ง

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## การใช้งาน

### เริ่มต้นเซิร์ฟเวอร์

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### 44. ทดสอบ

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

### ใช้งานร่วมกับ OpenClaw

คุณสามารถชี้ OpenClaw ไปยังพร็อกซีนี้เป็นเอ็นด์พอยต์แบบกำหนดเองที่เข้ากันได้กับ OpenAI ได้:

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

## โมเดลที่พร้อมใช้งาน

| รหัสโมเดล         | 45. แมปไปยัง |
| ----------------- | ----------------------------------- |
| `claude-opus-4`   | Claude Opus 4                       |
| `claude-sonnet-4` | Claude Sonnet 4                     |
| `claude-haiku-4`  | Claude Haiku 4                      |

## การเริ่มอัตโนมัติบน macOS

สร้าง LaunchAgent เพื่อรันพร็อกซีโดยอัตโนมัติ:

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

## ลิงก์

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## หมายเหตุ

- นี่เป็น **เครื่องมือจากชุมชน** ไม่ได้รับการสนับสนุนอย่างเป็นทางการจาก Anthropic หรือ OpenClaw
- ต้องมีการสมัครสมาชิก Claude Max/Pro ที่ยังใช้งานอยู่ และยืนยันตัวตน Claude Code CLI แล้ว
- พร็อกซีทำงานภายในเครื่องและไม่ส่งข้อมูลไปยังเซิร์ฟเวอร์ของบุคคลที่สาม
- รองรับการสตรีมคำตอบอย่างเต็มรูปแบบ

## ดูเพิ่มเติม

- [Anthropic provider](/providers/anthropic) - การผสานรวม OpenClaw แบบเนทีฟกับการตั้งค่า Claude setup-token หรือคีย์ API
- [OpenAI provider](/providers/openai) - สำหรับการสมัครสมาชิก OpenAI/Codex
