---
summary: "Signal support via signal-cli (JSON-RPC + SSE), 설정 경로, 그리고 번호 모델"
read_when:
  - Signal 지원 설정 중
  - Signal 전송/수신 디버깅 중
title: "Signal"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/channels/signal.md"
  workflow: 15
---

# Signal (signal-cli)

상태: 외부 CLI 통합. 게이트웨이는 HTTP JSON-RPC + SSE를 통해 `signal-cli`과 통신합니다.

## 필수 조건

- OpenClaw가 서버에 설치됨 (아래 테스트된 Linux 흐름은 Ubuntu 24).
- `signal-cli`이 게이트웨이를 실행하는 호스트에서 사용 가능.
- SMS 등록 경로를 위한 한 개의 검증 SMS를 받을 수 있는 전화번호.
- 등록 중 Signal captcha (`signalcaptchas.org`)를 위한 브라우저 접근.

## 빠른 설정 (초보자)

1. 봇용 **별도의 Signal 번호** 사용 (권장).
2. `signal-cli` 설치 (JVM 빌드를 사용할 경우 Java 필요).
3. 설정 경로 중 하나 선택:
   - **경로 A (QR 링크):** `signal-cli link -n "OpenClaw"` 및 Signal로 스캔.
   - **경로 B (SMS 등록):** captcha + SMS 검증으로 dedicated 번호 등록.
4. OpenClaw 설정 및 게이트웨이 재시작.
5. 첫 DM 보내고 페어링 승인 (`openclaw pairing approve signal <CODE>`).

최소 설정:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

필드 참조:

| 필드        | 설명                                          |
| ----------- | --------------------------------------------- |
| `account`   | E.164 형식의 봇 전화번호 (`+15551234567`)     |
| `cliPath`   | `signal-cli` 경로 (`signal-cli` if on `PATH`) |
| `dmPolicy`  | DM 접근 정책 (`pairing` 권장)                 |
| `allowFrom` | DM 허용 번호 또는 `uuid:<id>` 값              |

## 번호 모델 (중요)

- 게이트웨이는 **Signal 기기** (the `signal-cli` account)에 연결됩니다.
- **개인 Signal 계정**에서 봇을 실행하면 자신의 메시지를 무시합니다 (루프 보호).
- "봇에 텍스트하고 회신을 받으려면" **별도의 봇 번호** 사용.

[더 자세한 내용은 원본 영문 문서 참조]
