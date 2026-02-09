---
summary: "Voice Call 플러그인: Twilio/Telnyx/Plivo를 통한 아웃바운드 + 인바운드 통화 (플러그인 설치 + 구성 + CLI)"
read_when:
  - OpenClaw에서 아웃바운드 음성 통화를 걸고자 할 때
  - voice-call 플러그인을 구성하거나 개발할 때
title: "Voice Call 플러그인"
---

# Voice Call (플러그인)

플러그인을 통해 OpenClaw에서 음성 통화를 제공합니다. 아웃바운드 알림과 인바운드 정책을 포함한 다중 턴 대화를 지원합니다.

현재 프로바이더:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/네트워크 없음)

간단한 개념 모델:

- 플러그인 설치
- Gateway(게이트웨이) 재시작
- `plugins.entries.voice-call.config` 아래에서 구성
- `openclaw voicecall ...` 또는 `voice_call` 도구 사용

## 실행 위치 (로컬 vs 원격)

Voice Call 플러그인은 **Gateway(게이트웨이) 프로세스 내부**에서 실행됩니다.

원격 Gateway(게이트웨이)를 사용하는 경우, **Gateway(게이트웨이)가 실행 중인 머신**에 플러그인을 설치/구성한 다음 Gateway(게이트웨이)를 재시작하여 로드하십시오.

## 설치

### 옵션 A: npm에서 설치 (권장)

```bash
openclaw plugins install @openclaw/voice-call
```

이후 Gateway(게이트웨이)를 재시작하십시오.

### 옵션 B: 로컬 폴더에서 설치 (개발용, 복사 없음)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

이후 Gateway(게이트웨이)를 재시작하십시오.

## 구성

`plugins.entries.voice-call.config` 아래에 설정을 구성하십시오:

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

- Twilio/Telnyx는 **공개적으로 접근 가능한** 웹훅 URL이 필요합니다.
- Plivo는 **공개적으로 접근 가능한** 웹훅 URL이 필요합니다.
- `mock` 는 로컬 개발용 프로바이더입니다 (네트워크 호출 없음).
- `skipSignatureVerification` 는 로컬 테스트 전용입니다.
- ngrok 무료 티어를 사용하는 경우, `publicUrl` 를 정확한 ngrok URL로 설정하십시오. 서명 검증은 항상 강제됩니다.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` 는 `tunnel.provider="ngrok"` 이고 `serve.bind` 가 loopback (ngrok 로컬 에이전트)일 때에만 **유효하지 않은 서명**의 Twilio 웹훅을 허용합니다. 로컬 개발 전용으로 사용하십시오.
- ngrok 무료 티어 URL은 변경되거나 중간 인터스티셜 동작이 추가될 수 있습니다. `publicUrl` 가 변경되면 Twilio 서명 검증이 실패합니다. 프로덕션에서는 안정적인 도메인이나 Tailscale funnel을 권장합니다.

## 웹훅 보안

Gateway(게이트웨이) 앞단에 프록시 또는 터널이 있는 경우, 플러그인은 서명 검증을 위해
공개 URL을 재구성합니다. 다음 옵션은 신뢰할 전달 헤더를 제어합니다.

`webhookSecurity.allowedHosts` 는 전달 헤더의 호스트를 허용 목록으로 제한합니다.

`webhookSecurity.trustForwardingHeaders` 는 허용 목록 없이 전달 헤더를 신뢰합니다.

`webhookSecurity.trustedProxyIPs` 는 요청의 원격 IP가 목록과 일치할 때에만 전달 헤더를 신뢰합니다.

안정적인 공개 호스트를 사용하는 예:

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

## 통화를 위한 TTS

Voice Call은 통화 중 스트리밍 음성을 위해 핵심 `messages.tts` 구성 (OpenAI 또는 ElevenLabs)을 사용합니다. 플러그인 설정에서 **동일한 형태**로 이를 재정의할 수 있으며, `messages.tts` 와 딥 머지됩니다.

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

- **Edge TTS는 음성 통화에서 무시됩니다** (전화 오디오는 PCM이 필요하며 Edge 출력은 신뢰성이 떨어집니다).
- Twilio 미디어 스트리밍이 활성화된 경우 핵심 TTS가 사용되며, 그렇지 않으면 통화는 프로바이더 기본 음성으로 폴백됩니다.

### 추가 예제

핵심 TTS만 사용 (재정의 없음):

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

통화에 대해서만 ElevenLabs로 재정의 (다른 곳에서는 핵심 기본값 유지):

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

통화에 대해서만 OpenAI 모델을 재정의 (딥 머지 예):

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

## 수신 호출

인바운드 정책의 기본값은 `disabled` 입니다. 인바운드 통화를 활성화하려면 다음을 설정하십시오:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

자동 응답은 에이전트 시스템을 사용합니다. 다음으로 튜닝하십시오:

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

액션:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

이 저장소에는 `skills/voice-call/SKILL.md` 에 일치하는 skill 문서가 포함되어 있습니다.

## Gateway(게이트웨이) RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
