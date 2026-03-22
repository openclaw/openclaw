---
summary: "Voice Call 플러그인: Twilio/Telnyx/Plivo 를 통한 아웃바운드 + 인바운드 전화 (플러그인 설치 + 구성 + CLI)"
read_when:
  - OpenClaw 에서 아웃바운드 음성 전화를 걸려는 경우
  - voice-call 플러그인을 구성하거나 개발하는 경우
title: "Voice Call 플러그인"
x-i18n:
  source_path: docs/plugins/voice-call.md
---

# Voice Call (플러그인)

플러그인을 통한 OpenClaw 음성 통화. 아웃바운드 알림 및 인바운드 정책을 포함한 다중 턴 대화를 지원합니다.

현재 프로바이더:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (개발/네트워크 없음)

빠른 멘탈 모델:

- 플러그인 설치
- Gateway 재시작
- `plugins.entries.voice-call.config` 하위에서 구성
- `openclaw voicecall ...` 또는 `voice_call` 도구 사용

## 실행 위치 (로컬 vs 원격)

Voice Call 플러그인은 **Gateway 프로세스 내부**에서 실행됩니다.

원격 Gateway 를 사용하는 경우, **Gateway 를 실행하는 머신**에서 플러그인을 설치/구성한 후 Gateway 를 재시작하여 로드합니다.

## 설치

### 옵션 A: npm 에서 설치 (권장)

```bash
openclaw plugins install @openclaw/voice-call
```

이후 Gateway 를 재시작합니다.

### 옵션 B: 로컬 폴더에서 설치 (개발, 복사 없음)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

이후 Gateway 를 재시작합니다.

## 구성

`plugins.entries.voice-call.config` 하위에서 구성을 설정합니다:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // 또는 "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          telnyx: {
            apiKey: "...",
            connectionId: "...",
            publicKey: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
            preStartTimeoutMs: 5000,
            maxPendingConnections: 32,
            maxPendingConnectionsPerIp: 4,
            maxConnections: 128,
          },
        },
      },
    },
  },
}
```

참고:

- Twilio/Telnyx 는 **공개적으로 도달 가능한** 웹훅 URL 이 필요합니다.
- Plivo 는 **공개적으로 도달 가능한** 웹훅 URL 이 필요합니다.
- `mock` 은 로컬 개발 프로바이더입니다 (네트워크 호출 없음).
- Telnyx 는 `skipSignatureVerification` 이 true 가 아닌 한 `telnyx.publicKey` (또는 `TELNYX_PUBLIC_KEY`) 가 필요합니다.

## 오래된 전화 정리기

`staleCallReaperSeconds` 를 사용하여 터미널 웹훅을 받지 못한 전화를 종료합니다 (예: 완료되지 않은 notify 모드 전화). 기본값은 `0` (비활성화) 입니다.

권장 범위:

- **프로덕션:** notify 스타일 흐름에 `120`-`300` 초.
- 이 값을 **`maxDurationSeconds` 보다 높게** 유지하세요.

## 웹훅 보안

프록시나 터널이 Gateway 앞에 있을 때, 플러그인은 서명 검증을 위해 공개 URL 을 재구성합니다.

`webhookSecurity.allowedHosts` 는 전달 헤더의 호스트를 허용합니다.

`webhookSecurity.trustForwardingHeaders` 는 허용 목록 없이 전달 헤더를 신뢰합니다.

`webhookSecurity.trustedProxyIPs` 는 요청 원격 IP 가 목록과 일치할 때만 전달 헤더를 신뢰합니다.

## 전화용 TTS

Voice Call 은 전화 중 스트리밍 음성을 위해 코어 `messages.tts` 구성을 사용합니다. 플러그인 구성 하위에서 **동일한 형태**로 재정의할 수 있습니다 — `messages.tts` 와 딥 머지됩니다.

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

- **Microsoft 음성은 음성 전화에서 무시됩니다** (전화 오디오에는 PCM 이 필요하며 현재 Microsoft 전송은 전화 PCM 출력을 노출하지 않습니다).
- Twilio 미디어 스트리밍이 활성화되면 코어 TTS 가 사용됩니다. 그렇지 않으면 전화는 프로바이더 네이티브 음성으로 폴백합니다.

## 인바운드 전화

인바운드 정책은 기본적으로 `disabled` 입니다. 인바운드 전화를 활성화하려면:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

`inboundPolicy: "allowlist"` 는 저보증 발신자 ID 스크린입니다. 플러그인은 프로바이더가 제공한 `From` 값을 정규화하고 `allowFrom` 과 비교합니다. 웹훅 검증은 프로바이더 전달과 페이로드 무결성을 인증하지만, PSTN/VoIP 발신자 번호 소유를 증명하지는 않습니다. `allowFrom` 을 발신자 ID 필터링으로 취급하고, 강력한 발신자 신원으로 취급하지 마세요.

자동 응답은 에이전트 시스템을 사용합니다. 다음으로 조정합니다:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall start --to "+15555550123"   # call 의 별칭
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall latency                     # 로그에서 턴 지연 시간 요약
openclaw voicecall expose --mode funnel
```

`latency` 는 기본 voice-call 저장소 경로에서 `calls.jsonl` 을 읽습니다. 다른 로그를 가리키려면 `--file <path>` 를, 분석을 마지막 N 개 레코드로 제한하려면 `--last <n>` (기본값 200) 을 사용합니다. 출력에는 턴 지연 시간 및 청취 대기 시간의 p50/p90/p99 가 포함됩니다.

## 에이전트 도구

도구 이름: `voice_call`

액션:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

이 저장소는 `skills/voice-call/SKILL.md` 에 매칭되는 스킬 문서를 제공합니다.

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
