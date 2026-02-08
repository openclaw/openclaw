---
summary: "WhatsApp (웹 채널) 통합: 로그인, 수신함, 응답, 미디어, 운영"
read_when:
  - WhatsApp/웹 채널 동작이나 수신함 라우팅 작업 시
title: "WhatsApp"
---

# WhatsApp (웹 채널)

상태: Baileys를 통한 WhatsApp Web만 지원. Gateway가 세션을 소유합니다.

## 빠른 설정 (초보자)

1. 가능하면 **별도의 전화번호**를 사용하세요 (권장).
2. `~/.openclaw/openclaw.json`에서 WhatsApp을 설정합니다.
3. `openclaw channels login`을 실행하여 QR 코드를 스캔합니다 (연결된 기기).
4. Gateway를 시작합니다.

최소 설정:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+821012345678"],
    },
  },
}
```

## 목표

- 하나의 Gateway 프로세스에서 여러 WhatsApp 계정 (멀티 계정).
- 결정적 라우팅: 응답은 WhatsApp으로 돌아가며, 모델 라우팅 없음.
- 모델이 인용된 응답을 이해할 수 있도록 충분한 컨텍스트 제공.

## 아키텍처 (누가 무엇을 소유하는가)

- **Gateway**가 Baileys 소켓과 수신함 루프를 소유합니다.
- **CLI / macOS 앱**은 Gateway와 통신합니다; Baileys를 직접 사용하지 않습니다.
- 아웃바운드 전송에는 **활성 리스너**가 필요합니다; 그렇지 않으면 전송이 빠르게 실패합니다.

## 전화번호 얻기 (두 가지 모드)

WhatsApp은 인증을 위해 실제 모바일 번호가 필요합니다. VoIP 및 가상 번호는 보통 차단됩니다.

### 전용 번호 (권장)

OpenClaw용 **별도의 전화번호**를 사용하세요. 최고의 UX, 깔끔한 라우팅, 셀프 채팅 특이점 없음.

이상적인 설정: **여분의/오래된 Android 폰 + eSIM**. Wi-Fi와 전원에 연결해 두고 QR로 연결하세요.

**WhatsApp Business:** 같은 기기에서 다른 번호로 WhatsApp Business를 사용할 수 있습니다. 개인 WhatsApp을 분리하기에 좋습니다 — WhatsApp Business를 설치하고 OpenClaw 번호를 등록하세요.

**샘플 설정 (전용 번호, 단일 사용자 허용 목록):**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+821012345678"],
    },
  },
}
```

**페어링 모드 (선택사항):**

허용 목록 대신 페어링을 원하면 `channels.whatsapp.dmPolicy`를 `pairing`으로 설정하세요. 알 수 없는 발신자는 페어링 코드를 받습니다; 다음으로 승인합니다:
`openclaw pairing approve whatsapp <코드>`

### 개인 번호 (대안)

빠른 대안: **자신의 번호**로 OpenClaw를 실행합니다. 테스트를 위해 자신에게 메시지를 보내세요 (WhatsApp "나에게 메시지"). 설정 및 실험 중에 메인 폰에서 인증 코드를 읽어야 합니다. **셀프 채팅 모드를 활성화해야 합니다.**

**샘플 설정 (개인 번호, 셀프 채팅):**

```json5
{
  channels: {
    whatsapp: {
      selfChatMode: true,
      dmPolicy: "allowlist",
      allowFrom: ["+821012345678"],
    },
  },
}
```

### 번호 소싱 팁

- **로컬 eSIM**: 국내 통신사에서 (가장 신뢰할 수 있음)
- **선불 SIM**: 저렴, 인증용 SMS 한 번만 받으면 됨

**피해야 할 것:** TextNow, Google Voice, 대부분의 "무료 SMS" 서비스 — WhatsApp이 이들을 적극적으로 차단합니다.

## 로그인 + 자격 증명

- 로그인 명령: `openclaw channels login` (연결된 기기를 통한 QR).
- 멀티 계정 로그인: `openclaw channels login --account <id>` (`<id>` = `accountId`).
- 자격 증명 저장 위치: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`.
- 로그아웃: `openclaw channels logout` (또는 `--account <id>`)는 WhatsApp 인증 상태를 삭제합니다.

## 인바운드 흐름 (DM + 그룹)

- WhatsApp 이벤트는 `messages.upsert` (Baileys)에서 옵니다.
- 상태/브로드캐스트 채팅은 무시됩니다.
- 직접 채팅은 E.164를 사용합니다; 그룹은 그룹 JID를 사용합니다.
- **DM 정책**: `channels.whatsapp.dmPolicy`가 직접 채팅 접근을 제어합니다 (기본값: `pairing`).
  - 페어링: 알 수 없는 발신자는 페어링 코드를 받습니다 (`openclaw pairing approve whatsapp <코드>`로 승인; 코드는 1시간 후 만료).
  - 오픈: `channels.whatsapp.allowFrom`에 `"*"`가 포함되어야 합니다.

## 읽음 확인

기본적으로 Gateway는 수신한 WhatsApp 메시지에 읽음 표시(파란색 체크)를 합니다.

전역 비활성화:

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

## 그룹

- 그룹은 `agent:<agentId>:whatsapp:group:<jid>` 세션에 매핑됩니다.
- 그룹 정책: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (기본값 `allowlist`).
- 활성화 모드:
  - `mention` (기본값): @멘션 또는 정규식 일치가 필요합니다.
  - `always`: 항상 트리거됩니다.
- `/activation mention|always`는 소유자 전용이며 독립적인 메시지로 전송해야 합니다.
- **히스토리 주입** (대기 중만):
  - 최근 _처리되지 않은_ 메시지 (기본값 50개)가 삽입됩니다:
    `[마지막 응답 이후의 채팅 메시지 - 컨텍스트용]`

## 응답 전달 (스레딩)

- WhatsApp Web은 표준 메시지를 보냅니다 (현재 Gateway에서는 인용 응답 스레딩 없음).

## 제한사항

- 아웃바운드 텍스트는 `channels.whatsapp.textChunkLimit`로 청킹됩니다 (기본값 4000).
- 인바운드 미디어 저장은 `channels.whatsapp.mediaMaxMb`로 제한됩니다 (기본값 50 MB).
- 아웃바운드 미디어 항목은 `agents.defaults.mediaMaxMb`로 제한됩니다 (기본값 5 MB).

## 아웃바운드 전송 (텍스트 + 미디어)

- 활성 웹 리스너를 사용합니다; Gateway가 실행 중이 아니면 오류.
- 텍스트 청킹: 메시지당 최대 4k (설정 가능).
- 미디어:
  - 이미지/비디오/오디오/문서 지원.
  - 오디오는 PTT로 전송; `audio/ogg` => `audio/ogg; codecs=opus`.
  - 미디어 가져오기는 HTTP(S) 및 로컬 경로 지원.

## 설정 빠른 맵

| 설정 키                          | 설명                                         |
| -------------------------------- | -------------------------------------------- |
| `channels.whatsapp.dmPolicy`     | DM 정책: pairing/allowlist/open/disabled     |
| `channels.whatsapp.selfChatMode` | 동일 전화 설정; 봇이 개인 WhatsApp 번호 사용 |
| `channels.whatsapp.allowFrom`    | DM 허용 목록 (E.164 전화번호)                |
| `channels.whatsapp.mediaMaxMb`   | 인바운드 미디어 저장 제한                    |
| `channels.whatsapp.groupPolicy`  | 그룹 정책                                    |
| `channels.whatsapp.groups`       | 그룹 허용 목록 + 멘션 게이팅 기본값          |
| `agents.defaults.mediaMaxMb`     | 아웃바운드 미디어 제한                       |

## 로그 + 문제 해결

- 서브시스템: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- 로그 파일: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (설정 가능).
- 문제 해결 가이드: [Gateway 문제 해결](/ko-KR/gateway/troubleshooting).

## 문제 해결 (빠른 참조)

### 연결되지 않음 / QR 로그인 필요

- 증상: `channels status`가 `linked: false`로 표시되거나 "Not linked" 경고.
- 해결: Gateway 호스트에서 `openclaw channels login`을 실행하고 QR을 스캔합니다 (WhatsApp → 설정 → 연결된 기기).

### 연결되었지만 연결 끊김 / 재연결 루프

- 증상: `channels status`가 `running, disconnected`로 표시되거나 "Linked but disconnected" 경고.
- 해결: `openclaw doctor` (또는 Gateway 재시작). 지속되면 `channels login`으로 다시 연결하고 `openclaw logs --follow`를 검사합니다.

### Bun 런타임

- Bun은 **권장되지 않습니다**. WhatsApp (Baileys)과 Telegram은 Bun에서 불안정합니다.
  Gateway를 **Node**로 실행하세요.
