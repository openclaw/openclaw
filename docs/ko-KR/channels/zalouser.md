---
summary: "zca-cli (QR 로그인), 기능 및 설정을 통한 Zalo 개인 계정 지원"
read_when:
  - OpenClaw 에서 Zalo Personal 설정
  - Zalo Personal 로그인 또는 메시지 흐름 디버깅
title: "Zalo Personal"
---

# Zalo Personal (비공식)

상태: 실험적. 이 통합은 `zca-cli`를 통해 **개인 Zalo 계정**을 자동화합니다.

> **경고:** 이것은 비공식 통합으로 계정 정지/차단이 발생할 수 있습니다. 사용 시 주의를 기울이세요.

## 필요 플러그인

Zalo Personal은 플러그인으로 제공되며 기본 설치에는 포함되지 않습니다.

- CLI를 통해 설치: `openclaw plugins install @openclaw/zalouser`
- 또는 소스 체크아웃에서 설치: `openclaw plugins install ./extensions/zalouser`
- 자세한 내용: [플러그인](/ko-KR/tools/plugin)

## 필수 조건: zca-cli

게이트웨이 머신에는 `zca` 바이너리가 `PATH`에 있어야 합니다.

- 확인: `zca --version`
- 누락된 경우, zca-cli를 설치하세요 (`extensions/zalouser/README.md` 또는 업스트림 zca-cli 문서 참조).

## 빠른 설정 (초보자용)

1. 플러그인을 설치하세요 (위 참조).
2. 로그인 (QR, 게이트웨이 머신에서):
   - `openclaw channels login --channel zalouser`
   - 터미널에서 Zalo 모바일 앱으로 QR 코드를 스캔하십시오.
3. 채널 활성화:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. 게이트웨이를 재시작하세요 (또는 온보딩을 완료하세요).
5. 다이렉트 메시지 접근은 기본적으로 페어링으로 설정되며, 처음 접속 시 페어링 코드를 승인하세요.

## 사용 목적

- `zca listen`을 사용하여 수신 메시지를 받습니다.
- `zca msg ...`을 사용하여 답장을 보냅니다 (텍스트/미디어/링크).
- Zalo Bot API가 제공되지 않는 “개인 계정” 사용 사례를 위해 설계되었습니다.

## 명명

채널 ID는 `zalouser`로 설정되어 **개인 Zalo 사용자 계정**을 자동화하는 것임을 명확히 합니다 (비공식). 우리는 미래의 공식 Zalo API 통합을 위해 `zalo`를 예약합니다.

## ID 찾기 (디렉토리)

디렉토리 CLI를 사용하여 동료/그룹 및 그들의 ID를 검색합니다:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 제한 사항

- 발신 텍스트는 ~2000자로 분할됩니다 (Zalo 클라이언트 제한).
- 스트리밍은 기본적으로 차단됩니다.

## 접근 제어 (다이렉트 메시지)

`channels.zalouser.dmPolicy`는 다음을 지원합니다: `pairing | allowlist | open | disabled` (기본값: `pairing`).
`channels.zalouser.allowFrom`은 사용자 ID 또는 이름을 받습니다. 마법사는 가능한 경우 `zca 친구 찾기`를 통해 이름을 ID로 변환합니다.

승인 방법:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## 그룹 접근 (선택 사항)

- 기본값: `channels.zalouser.groupPolicy = "open"` (그룹 허용). 설정되지 않은 경우 기본값을 재정의하려면 `channels.defaults.groupPolicy`를 사용합니다.
- 허용 목록으로 제한:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (키는 그룹 ID 또는 이름)
- 모든 그룹 차단: `channels.zalouser.groupPolicy = "disabled"`.
- 설정 마법사가 그룹 허용 목록을 프롬프트할 수 있습니다.
- 시작 시, OpenClaw는 허용 목록의 그룹/사용자 이름을 ID로 변환하고 매핑을 기록합니다. 해결되지 않은 항목은 입력된 상태로 유지됩니다.

예시:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## 다중 계정

계정은 zca 프로필에 매핑됩니다. 예시:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## 문제 해결

**`zca`를 찾을 수 없음:**

- zca-cli를 설치하고 게이트웨이 프로세스를 위해 `PATH`에 있는지 확인하세요.

**로그인이 유지되지 않음:**

- `openclaw channels status --probe`
- 다시 로그인: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`