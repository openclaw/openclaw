---
summary: "Voice Call plugin: outbound + inbound calls via Twilio/Telnyx/Plivo (plugin install + config + CLI)"
read_when:
  - OpenClaw에서 발신 음성 전화를 걸고 싶습니다.
  - 음성 통화 플러그인을 구성하거나 개발하고 있습니다.
title: "Voice Call Plugin"
---

# Voice Call (plugin)

OpenClaw를 위한 음성 통화 플러그인입니다. 발신 알림과 인바운드 정책을 사용한 다중 턴 대화를 지원합니다.

현재 프로바이더:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML 전송 + GetInput 음성)
- `mock` (개발/네트워크 없음)

간단한 모델:

- 플러그인 설치
- 게이트웨이 재시작
- `plugins.entries.voice-call.config`에 구성
- `openclaw voicecall ...` 또는 `voice_call` 도구 사용

## 실행 위치 (로컬 vs 원격)

Voice Call 플러그인은 **게이트웨이 프로세스 내부**에서 실행됩니다.

원격 게이트웨이를 사용하는 경우, **게이트웨이를 실행하는 기기**에 플러그인을 설치/구성한 후 게이트웨이를 재시작하여 로드합니다.

## 설치

### 옵션 A: npm에서 설치 (권장)

```bash
openclaw plugins install @openclaw/voice-call
```

이후 게이트웨이를 재시작하세요.

### 옵션 B: 로컬 폴더에서 설치 (개발, 복사 없음)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

이후 게이트웨이를 재시작하세요.

## 설정

`plugins.entries.voice-call.config`에 설정 구성:

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

          telnyx: {
            apiKey: "...",
            connectionId: "...",
            // Telnyx 웹훅 공개 키 (Base64 문자열; TELNYX_PUBLIC_KEY를 통해 설정 가능).
            publicKey: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook 서버
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook 보안 (터널/프록시를 위한 권장 설정)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // 공개 노출 (하나 선택)
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

참고 사항:

- Twilio/Telnyx는 **공개적으로 접근 가능한** 웹훅 URL이 필요합니다.
- Plivo는 **공개적으로 접근 가능한** 웹훅 URL이 필요합니다.
- `mock`은 로컬 개발용 프로바이더입니다 (네트워크 호출 없음).
- Telnyx는 `telnyx.publicKey` (또는 `TELNYX_PUBLIC_KEY`)가 필요합니다 (`skipSignatureVerification`이 true가 아닌 경우).
- `skipSignatureVerification`은 로컬 테스트에만 사용됩니다.
- 무료 ngrok를 사용하는 경우, 정확한 ngrok URL을 `publicUrl`로 설정하세요; 서명 검증은 항상 적용됩니다.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true`는 `serve.bind`가 로컬 루프백일 때 (ngrok 로컬 에이전트) **단지** `tunnel.provider="ngrok"`일 때 Twilio 웹훅을 허용합니다. 로컬 개발에만 사용하세요.
- ngrok 무료 tier URL은 변경되거나 중간 행동을 추가할 수 있습니다; `publicUrl`이 변동하면 Twilio 서명이 실패합니다. 상용 환경에서는 안정적인 도메인이나 Tailscale 퍼널을 선호하세요.

## Stale call reaper

종료 웹훅을 전혀 받지 못한 통화를 종료하려면 `staleCallReaperSeconds`를 사용하세요 (예: 완료되지 않은 알림 모드 통화). 기본값은 `0` (비활성화)입니다.

권장 범위:

- **상용 환경:** 알림 스타일 흐름의 경우 `120`–`300`초.
- 이 값을 **`maxDurationSeconds`보다 높게** 유지하여 정상적인 통화가 완료될 수 있도록 하세요. 좋은 시작점은 `maxDurationSeconds + 30–60`초입니다.

예제:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          maxDurationSeconds: 300,
          staleCallReaperSeconds: 360,
        },
      },
    },
  },
}
```

## Webhook 보안

프록시나 터널이 게이트웨이 앞단에 있을 때, 플러그인은 서명 검증을 위해 공개 URL을 재구성합니다. 이러한 옵션들은 어떤 전달 헤더가 신뢰될지 제어합니다.

`webhookSecurity.allowedHosts`는 전달 헤더에서 호스트를 허용합니다.

`webhookSecurity.trustForwardingHeaders`는 허용 리스트 없이 전달된 헤더를 신뢰합니다.

`webhookSecurity.trustedProxyIPs`는 요청 리모트 IP가 목록과 일치할 때만 전달 헤더를 신뢰합니다.

안정적인 공개 호스트 예시:

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

Voice Call은 호출 시 스트리밍 음성을 위한 코어 `messages.tts` 구성을 사용합니다 (OpenAI 또는 ElevenLabs). 플러그인 구성에서 **동일한 형식**으로 이를 재정의할 수 있으며 `messages.tts`와 깊게 병합됩니다.

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

참고 사항:

- **Edge TTS는 음성 통화에서 무시됩니다** (전화 오디오는 PCM이 필요하며 Edge 출력은 신뢰할 수 없음).
- 코어 TTS는 Twilio 미디어 스트리밍이 활성화된 경우 사용됩니다; 그렇지 않으면 통화는 프로바이더 기본 음성으로 돌아갑니다.

### 추가 예시

코어 TTS만 사용 (재정의 없음):

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

통화에만 대해 ElevenLabs로 재정의 (다른 곳에서는 코어 기본값 유지):

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

통화에 대해서만 OpenAI 모델 재정의 (깊은 병합 예시):

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

인바운드 정책은 기본적으로 `disabled`로 설정됩니다. 인바운드 통화를 활성화하려면 다음을 설정하세요:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

자동 응답은 에이전트 시스템을 사용합니다. 다음으로 조정합니다:

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

이 저장소는 `skills/voice-call/SKILL.md`에 일치하는 스킬 문서를 제공합니다.

## 게이트웨이 RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)