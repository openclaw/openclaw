---
summary: "음성 통화 플러그인: Twilio/Telnyx/Plivo를 통한 아웃바운드 + 인바운드 통화 (플러그인 설치 + 구성 + CLI)"
read_when:
  - "OpenClaw에서 아웃바운드 음성 통화를 배치하고 싶을 때"
  - "음성 통화 플러그인을 구성하거나 개발할 때"
title: "음성 통화 플러그인"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/plugins/voice-call.md
  workflow: 15
---

# 음성 통화 (플러그인)

플러그인을 통한 OpenClaw용 음성 통화. 아웃바운드 알림 및 인바운드 정책이 있는 다중 턴 대화를 지원합니다.

현재 제공자:

- `twilio` (프로그래밍 가능한 음성 + 미디어 스트림)
- `telnyx` (통화 제어 v2)
- `plivo` (음성 API + XML 전송 + GetInput 음성)
- `mock` (개발/네트워크 없음)

빠른 멘탈 모델:

- 플러그인 설치
- Gateway 다시 시작
- `plugins.entries.voice-call.config` 아래에서 구성
- `openclaw voicecall ...` 또는 `voice_call` 도구 사용

## 실행 위치 (로컬 vs 원격)

음성 통화 플러그인은 **Gateway 프로세스 내에서 실행**합니다.

원격 Gateway를 사용하면 **Gateway를 실행하는 머신에 플러그인을 설치/구성**한 다음 Gateway를 다시 시작하여 로드합니다.

## 설치

### 옵션 A: npm에서 설치 (권장)

```bash
openclaw plugins install @openclaw/voice-call
```

그 후 Gateway를 다시 시작합니다.

### 옵션 B: 로컬 폴더에서 설치 (개발, 복사 없음)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

그 후 Gateway를 다시 시작합니다.

## 구성

`plugins.entries.voice-call.config` 아래에서 구성을 설정합니다:

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
            // Telnyx 미션 컨트롤 포털의 Telnyx webhook 공개 키
            // (Base64 문자열; 또한 TELNYX_PUBLIC_KEY로 설정 가능).
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

          // Webhook 보안 (터널/프록시에 권장)
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

메모:

- Twilio/Telnyx는 **공개적으로 접근 가능한** webhook URL이 필요합니다.
- Plivo는 **공개적으로 접근 가능한** webhook URL이 필요합니다.
- `mock`은 로컬 개발 제공자 (네트워크 호출 없음).
- Telnyx는 `telnyx.publicKey` (또는 `TELNYX_PUBLIC_KEY`)가 필요합니다 (`skipSignatureVerification`이 true가 아니면).
- `skipSignatureVerification`은 로컬 테스트만 해당합니다.
- ngrok free tier를 사용하면 `publicUrl`을 정확한 ngrok URL로 설정합니다; 서명 검증이 항상 강제됩니다.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true`는 `tunnel.provider="ngrok"` 및 `serve.bind`가 loopback일 때 (ngrok 로컬 에이전트)만 Twilio webhook 서명을 거부합니다. 로컬 개발만 해당합니다.
- Ngrok free tier URL은 변경되거나 중간 동작을 추가할 수 있습니다. `publicUrl`이 드리프트하면 Twilio 서명이 실패합니다. 프로덕션의 경우 안정적인 도메인 또는 Tailscale funnel을 선호합니다.

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

## Agent 도구

도구 이름: `voice_call`

작업:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

이 repo는 `skills/voice-call/SKILL.md`에서 매칭 스킬 문서를 제공합니다.

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
