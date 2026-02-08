---
read_when:
    - OpenClaw에서 아웃바운드 음성 통화를 걸고 싶습니다.
    - 음성 통화 플러그인을 구성 또는 개발 중입니다.
summary: '음성 통화 플러그인: Twilio/Telnyx/Plivo를 통한 아웃바운드 + 인바운드 통화(플러그인 설치 + 구성 + CLI)'
title: 음성 통화 플러그인
x-i18n:
    generated_at: "2026-02-08T16:09:06Z"
    model: gtx
    provider: google-translate
    source_hash: 46d05a5912b785d79125a8753481bf6a16798350de32f5833dbf86d4488768f0
    source_path: plugins/voice-call.md
    workflow: 15
---

# 음성 통화(플러그인)

플러그인을 통해 OpenClaw에 대한 음성 통화. 아웃바운드 알림을 지원하며
인바운드 정책을 사용한 다단계 대화.

현재 제공업체:

- `twilio` (프로그래밍 가능한 음성 + 미디어 스트림)
- `telnyx` (통화 제어 v2)
- `plivo` (음성 API + XML 전송 + GetInput 음성)
- `mock` (개발자/네트워크 없음)

빠른 정신 모델:

- 플러그인 설치
- 게이트웨이 다시 시작
- 아래에서 구성 `plugins.entries.voice-call.config`
- 사용 `openclaw voicecall ...` 또는 `voice_call` 도구

## 실행 위치(로컬 대 원격)

음성 통화 플러그인이 실행됩니다. **게이트웨이 프로세스 내부**.

원격 게이트웨이를 사용하는 경우 해당 게이트웨이에 플러그인을 설치/구성하세요. **게이트웨이를 실행하는 머신**를 클릭한 다음 게이트웨이를 다시 시작하여 로드하세요.

## 설치하다

### 옵션 A: npm에서 설치(권장)

```bash
openclaw plugins install @openclaw/voice-call
```

나중에 게이트웨이를 다시 시작하십시오.

### 옵션 B: 로컬 폴더에서 설치(dev, 복사 없음)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

나중에 게이트웨이를 다시 시작하십시오.

## 구성

아래에서 구성을 설정하세요. `plugins.entries.voice-call.config`:

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

참고:

- Twilio/Telnyx에는 **공개적으로 접근 가능** 웹훅 URL.
- Plivo에는 **공개적으로 접근 가능** 웹훅 URL.
- `mock` 로컬 개발 공급자입니다(네트워크 호출 없음).
- `skipSignatureVerification` 로컬 테스트 전용입니다.
- ngrok 무료 계층을 사용하는 경우 다음을 설정하세요. `publicUrl` 정확한 ngrok URL로; 서명 확인은 항상 시행됩니다.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` 서명이 잘못된 Twilio 웹후크를 허용합니다. **오직** 언제 `tunnel.provider="ngrok"` 그리고 `serve.bind` 루프백(ngrok 로컬 에이전트)입니다. 로컬 개발에만 사용하세요.
- Ngrok 무료 계층 URL은 전면 광고 동작을 변경하거나 추가할 수 있습니다. 만약에 `publicUrl` 드리프트하면 Twilio 서명이 실패합니다. 생산을 위해서는 안정적인 도메인이나 Tailscale 퍼널을 선호하세요.

## 웹훅 보안

프록시나 터널이 게이트웨이 앞에 있으면 플러그인은
서명 확인을 위한 공개 URL입니다. 이 옵션은 전달할 내용을 제어합니다.
헤더는 신뢰할 수 있습니다.

`webhookSecurity.allowedHosts` 전달 헤더에서 호스트를 허용 목록에 추가합니다.

`webhookSecurity.trustForwardingHeaders` 허용 목록 없이 전달된 헤더를 신뢰합니다.

`webhookSecurity.trustedProxyIPs` 요청 시 전달된 헤더만 신뢰합니다.
원격 IP가 목록과 일치합니다.

안정적인 공개 호스트의 예:

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

## 통화용 TTS

음성 통화는 코어를 사용합니다. `messages.tts` 구성(OpenAI 또는 ElevenLabs)
통화 중 음성 스트리밍. 다음을 사용하여 플러그인 구성에서 이를 재정의할 수 있습니다.
**같은 모양** — 그것은 다음과 깊게 병합됩니다. `messages.tts`.

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

참고:

- **음성 통화에서는 Edge TTS가 무시됩니다.** (전화 통신 오디오에는 PCM이 필요합니다. Edge 출력은 신뢰할 수 없습니다.)
- Twilio 미디어 스트리밍이 활성화되면 핵심 TTS가 사용됩니다. 그렇지 않으면 호출이 공급자 기본 음성으로 대체됩니다.

### 더 많은 예시

핵심 TTS만 사용(재정의 없음):

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

호출에 대해서만 ElevenLabs로 재정의합니다(다른 곳에서는 핵심 기본값을 유지).

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

호출에 대한 OpenAI 모델만 재정의합니다(심층 병합 예):

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

## 인바운드 통화

인바운드 정책의 기본값은 다음과 같습니다. `disabled`. 수신 통화를 활성화하려면 다음을 설정하십시오.

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

자동 응답은 상담원 시스템을 사용합니다. 다음과 같이 조정하세요.

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

## 에이전트 도구

도구 이름: `voice_call`

행위:

- `initiate_call` (메시지, to?, 모드?)
- `continue_call` (통화 ID, 메시지)
- `speak_to_user` (통화 ID, 메시지)
- `end_call` (통화 ID)
- `get_status` (통화 ID)

이 저장소는 일치하는 기술 문서를 다음 위치에 제공합니다. `skills/voice-call/SKILL.md`.

## 게이트웨이 RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
