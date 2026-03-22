---
summary: "Tlon/Urbit 지원 상태, 기능, 구성"
read_when:
  - Tlon/Urbit 채널 기능을 작업하는 경우
title: "Tlon"
x-i18n:
  source_path: docs/channels/tlon.md
---

# Tlon (플러그인)

Tlon 은 Urbit 위에 구축된 분산형 메신저입니다. OpenClaw 는 Urbit ship 에 연결하여 DM 과 그룹 채팅 메시지에 응답할 수 있습니다. 그룹 응답은 기본적으로 @ 멘션이 필요하며 허용 목록을 통해 추가로 제한할 수 있습니다.

상태: 플러그인을 통해 지원됨. DM, 그룹 멘션, 스레드 응답, 리치 텍스트 형식, 이미지 업로드가 지원됩니다. 리액션과 투표는 아직 지원되지 않습니다.

## 플러그인 필요

Tlon 은 플러그인으로 제공되며 코어 설치에 번들되지 않습니다.

CLI 를 통한 설치 (npm 레지스트리):

```bash
openclaw plugins install @openclaw/tlon
```

로컬 checkout (git 저장소에서 실행할 때):

```bash
openclaw plugins install ./extensions/tlon
```

자세한 내용: [Plugins](/tools/plugin)

## 설정

1. Tlon 플러그인을 설치합니다.
2. ship URL 과 로그인 코드를 수집합니다.
3. `channels.tlon` 을 구성합니다.
4. Gateway 를 재시작합니다.
5. 봇에게 DM 을 보내거나 그룹 채널에서 멘션합니다.

최소 구성 (단일 계정):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
      ownerShip: "~your-main-ship", // 권장: 항상 허용되는 자신의 ship
    },
  },
}
```

## 프라이빗/LAN ship

기본적으로 OpenClaw 는 SSRF 보호를 위해 프라이빗/내부 호스트명과 IP 범위를 차단합니다.
ship 이 프라이빗 네트워크 (localhost, LAN IP, 내부 호스트명) 에서 실행 중인 경우 명시적으로 옵트인해야 합니다:

```json5
{
  channels: {
    tlon: {
      url: "http://localhost:8080",
      allowPrivateNetwork: true,
    },
  },
}
```

로컬 네트워크를 신뢰하는 경우에만 활성화하세요. 이 설정은 ship URL 에 대한 요청의 SSRF 보호를 비활성화합니다.

## 그룹 채널

자동 검색이 기본적으로 활성화됩니다. 채널을 수동으로 고정할 수도 있습니다:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

자동 검색 비활성화:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## 접근 제어

DM 허용 목록 (비어 있으면 = DM 허용 안 됨, 승인 흐름에는 `ownerShip` 사용):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

그룹 권한 부여 (기본적으로 제한됨):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## 소유자 및 승인 시스템

권한이 없는 사용자가 상호 작용을 시도할 때 승인 요청을 받을 소유자 ship 을 설정합니다:

```json5
{
  channels: {
    tlon: {
      ownerShip: "~your-main-ship",
    },
  },
}
```

소유자 ship 은 **모든 곳에서 자동으로 권한이 부여됩니다** — DM 초대가 자동 수락되고 채널 메시지가 항상 허용됩니다. 소유자를 `dmAllowlist` 나 `defaultAuthorizedShips` 에 추가할 필요가 없습니다.

## 전달 대상 (CLI/cron)

`openclaw message send` 또는 cron 전달에 사용합니다:

- DM: `~sampel-palnet` 또는 `dm/~sampel-palnet`
- 그룹: `chat/~host-ship/channel` 또는 `group:~host-ship/channel`

## 번들 스킬

Tlon 플러그인에는 Tlon 작업에 대한 CLI 접근을 제공하는 번들 스킬이 포함되어 있습니다.

스킬은 플러그인이 설치되면 자동으로 사용 가능합니다.

## 기능

| 기능            | 상태                                |
| --------------- | ----------------------------------- |
| 다이렉트 메시지 | 지원됨                              |
| 그룹/채널       | 지원됨 (기본적으로 멘션 게이팅)     |
| 스레드          | 지원됨 (스레드 내 자동 응답)        |
| 리치 텍스트     | Markdown 을 Tlon 형식으로 변환      |
| 이미지          | Tlon 스토리지에 업로드              |
| 리액션          | [번들 스킬](#bundled-skill) 을 통해 |
| 투표            | 아직 미지원                         |
| 네이티브 명령   | 지원됨 (기본적으로 소유자 전용)     |

## 문제 해결

먼저 이 순서로 실행합니다:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
```

일반적인 실패:

- **DM 무시됨**: 발신자가 `dmAllowlist` 에 없고 승인 흐름을 위한 `ownerShip` 이 구성되지 않음.
- **그룹 메시지 무시됨**: 채널이 검색되지 않았거나 발신자가 권한 없음.
- **연결 오류**: ship URL 이 도달 가능한지 확인. 로컬 ship 에는 `allowPrivateNetwork` 를 활성화.
- **인증 오류**: 로그인 코드가 현재 것인지 확인 (코드가 순환됨).

## 구성 참조

전체 구성: [Configuration](/gateway/configuration)

프로바이더 옵션:

- `channels.tlon.enabled`: 채널 시작 활성화/비활성화.
- `channels.tlon.ship`: 봇의 Urbit ship 이름 (예: `~sampel-palnet`).
- `channels.tlon.url`: ship URL (예: `https://sampel-palnet.tlon.network`).
- `channels.tlon.code`: ship 로그인 코드.
- `channels.tlon.allowPrivateNetwork`: localhost/LAN URL 허용 (SSRF 우회).
- `channels.tlon.ownerShip`: 승인 시스템용 소유자 ship (항상 권한 부여).
- `channels.tlon.dmAllowlist`: DM 이 허용된 ship (비어 있으면 = 없음).
- `channels.tlon.autoAcceptDmInvites`: 허용 목록에 있는 ship 의 DM 자동 수락.
- `channels.tlon.autoAcceptGroupInvites`: 모든 그룹 초대 자동 수락.
- `channels.tlon.autoDiscoverChannels`: 그룹 채널 자동 검색 (기본값: true).
- `channels.tlon.groupChannels`: 수동으로 고정된 채널 nest.
- `channels.tlon.defaultAuthorizedShips`: 모든 채널에 권한이 부여된 ship.
- `channels.tlon.authorization.channelRules`: 채널별 권한 규칙.
- `channels.tlon.showModelSignature`: 메시지에 모델 이름 추가.

## 참고 사항

- 그룹 응답은 멘션 (예: `~your-bot-ship`) 이 필요합니다.
- 스레드 응답: 인바운드 메시지가 스레드에 있으면 OpenClaw 가 스레드 내에서 응답합니다.
- 리치 텍스트: Markdown 형식 (굵게, 기울임, 코드, 제목, 목록) 이 Tlon 의 네이티브 형식으로 변환됩니다.
- 이미지: URL 이 Tlon 스토리지에 업로드되어 이미지 블록으로 삽입됩니다.
