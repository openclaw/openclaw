---
summary: "Plugin Voice Call: cuộc gọi đi + đến qua Twilio/Telnyx/Plivo (cài plugin + cấu hình + CLI)"
read_when:
  - Bạn muốn thực hiện một cuộc gọi thoại đi từ OpenClaw
  - Bạn đang cấu hình hoặc phát triển plugin voice-call
title: "Plugin Voice Call"
---

# Voice Call (plugin)

Voice calls for OpenClaw via a plugin. Supports outbound notifications and
multi-turn conversations with inbound policies.

Các nhà cung cấp hiện tại:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/không mạng)

Mô hình tư duy nhanh:

- Cài plugin
- Khởi động lại Gateway
- Cấu hình dưới `plugins.entries.voice-call.config`
- Dùng `openclaw voicecall ...` hoặc công cụ `voice_call`

## Nơi chạy (local vs remote)

Plugin Voice Call chạy **bên trong tiến trình Gateway**.

Nếu bạn dùng Gateway từ xa, hãy cài/cấu hình plugin trên **máy chạy Gateway**, sau đó khởi động lại Gateway để tải plugin.

## Cài đặt

### Tùy chọn A: cài từ npm (khuyến nghị)

```bash
openclaw plugins install @openclaw/voice-call
```

Khởi động lại Gateway sau đó.

### Tùy chọn B: cài từ thư mục local (dev, không sao chép)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Khởi động lại Gateway sau đó.

## Cấu hình

Đặt cấu hình dưới `plugins.entries.voice-call.config`:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
          },
        },
      },
    },
  },
}
```

Ghi chú:

- Twilio/Telnyx yêu cầu URL webhook **có thể truy cập công khai**.
- Plivo yêu cầu URL webhook **có thể truy cập công khai**.
- `mock` là nhà cung cấp dev local (không gọi mạng).
- `skipSignatureVerification` chỉ dành cho kiểm thử local.
- Nếu bạn dùng ngrok gói miễn phí, đặt `publicUrl` thành đúng URL ngrok; việc xác minh chữ ký luôn được áp dụng.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` allows Twilio webhooks with invalid signatures **only** when `tunnel.provider="ngrok"` and `serve.bind` is loopback (ngrok local agent). Chỉ dùng cho môi trường phát triển cục bộ.
- Ngrok free tier URLs can change or add interstitial behavior; if `publicUrl` drifts, Twilio signatures will fail. For production, prefer a stable domain or Tailscale funnel.

## Bảo mật Webhook

When a proxy or tunnel sits in front of the Gateway, the plugin reconstructs the
public URL for signature verification. Các tùy chọn này kiểm soát những header được chuyển tiếp nào là đáng tin cậy.

`webhookSecurity.allowedHosts` cho phép danh sách host từ các header chuyển tiếp.

`webhookSecurity.trustForwardingHeaders` tin cậy các header chuyển tiếp mà không cần danh sách cho phép.

`webhookSecurity.trustedProxyIPs` chỉ tin cậy các header chuyển tiếp khi IP remote của
request khớp với danh sách.

Ví dụ với một host công khai ổn định:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
          },
        },
      },
    },
  },
}
```

## TTS cho cuộc gọi

Voice Call uses the core `messages.tts` configuration (OpenAI or ElevenLabs) for
streaming speech on calls. You can override it under the plugin config with the
**same shape** — it deep‑merges with `messages.tts`.

```json5
{
  tts: {
    provider: "elevenlabs",
    elevenlabs: {
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
    },
  },
}
```

Ghi chú:

- **Edge TTS bị bỏ qua cho cuộc gọi thoại** (âm thanh điện thoại cần PCM; đầu ra Edge không ổn định).
- TTS cốt lõi được dùng khi bật Twilio media streaming; nếu không, cuộc gọi sẽ dùng giọng nói native của nhà cung cấp.

### Thêm ví dụ

Chỉ dùng TTS cốt lõi (không ghi đè):

```json5
{
  messages: {
    tts: {
      provider: "openai",
      openai: { voice: "alloy" },
    },
  },
}
```

Ghi đè sang ElevenLabs chỉ cho cuộc gọi (giữ mặc định cốt lõi ở nơi khác):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "elevenlabs_key",
              voiceId: "pMsXgVXv3BLzUgSXRplE",
              modelId: "eleven_multilingual_v2",
            },
          },
        },
      },
    },
  },
}
```

Chỉ ghi đè model OpenAI cho cuộc gọi (ví dụ deep‑merge):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            openai: {
              model: "gpt-4o-mini-tts",
              voice: "marin",
            },
          },
        },
      },
    },
  },
}
```

## Cuộc gọi đến

Inbound policy defaults to `disabled`. Để bật cuộc gọi inbound, hãy đặt:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Auto-responses use the agent system. Tune with:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Công cụ agent

Tên công cụ: `voice_call`

Hành động:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Repo này cung cấp tài liệu skill tương ứng tại `skills/voice-call/SKILL.md`.

## RPC của Gateway

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
