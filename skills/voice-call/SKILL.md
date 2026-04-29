---
name: voice-call
description: Start voice calls via the OpenClaw voice-call plugin.
metadata:
  {
    "openclaw":
      {
        "emoji": "📞",
        "skillKey": "voice-call",
        "requires": { "config": ["plugins.entries.voice-call.enabled"] },
      },
  }
---

# Voice Call

使用 voice-call 插件启动或检查通话（Twilio、Telnyx、Plivo 或 mock）。

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall status --call-id <id>
```

## 工具

使用 `voice_call` 进行 agent 发起的通话。

操作：

- `initiate_call`（message、to?、mode?）
- `continue_call`（callId、message）
- `speak_to_user`（callId、message）
- `end_call`（callId）
- `get_status`（callId）

注意事项：

- 需要启用 voice-call 插件。
- 插件配置位于 `plugins.entries.voice-call.config` 下。
- Twilio 配置：`provider: "twilio"` + `twilio.accountSid/authToken` + `fromNumber`。
- Telnyx 配置：`provider: "telnyx"` + `telnyx.apiKey/connectionId` + `fromNumber`。
- Plivo 配置：`provider: "plivo"` + `plivo.authId/authToken` + `fromNumber`。
- 开发回退：`provider: "mock"`（无网络）。
