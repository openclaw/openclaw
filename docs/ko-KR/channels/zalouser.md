---
summary: "네이티브 zca-js 를 통한 Zalo 개인 계정 지원 (QR 로그인), 기능, 구성"
read_when:
  - OpenClaw 용 Zalo Personal 을 설정하는 경우
  - Zalo Personal 로그인 또는 메시지 흐름을 디버깅하는 경우
title: "Zalo Personal"
x-i18n:
  source_path: docs/channels/zalouser.md
---

# Zalo Personal (비공식)

상태: 실험적. 이 통합은 OpenClaw 내부에서 네이티브 `zca-js` 를 통해 **개인 Zalo 계정**을 자동화합니다.

> **경고:** 이것은 비공식 통합이며 계정 정지/차단이 발생할 수 있습니다. 자기 책임 하에 사용하세요.

## 플러그인 필요

Zalo Personal 은 플러그인으로 제공되며 코어 설치에 번들되지 않습니다.

- CLI 를 통한 설치: `openclaw plugins install @openclaw/zalouser`
- 또는 소스 checkout 에서: `openclaw plugins install ./extensions/zalouser`
- 자세한 내용: [Plugins](/tools/plugin)

외부 `zca`/`openzca` CLI 바이너리는 필요하지 않습니다.

## 빠른 설정 (초보자)

1. 플러그인을 설치합니다 (위 참조).
2. 로그인 (QR, Gateway 머신에서):
   - `openclaw channels login --channel zalouser`
   - Zalo 모바일 앱으로 QR 코드를 스캔합니다.
3. 채널을 활성화합니다:

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

4. Gateway 를 재시작합니다 (또는 설정을 완료합니다).
5. DM 접근은 기본적으로 페어링입니다. 첫 연락 시 페어링 코드를 승인합니다.

## 이것이 무엇인가

- `zca-js` 를 통해 완전히 프로세스 내에서 실행됩니다.
- 네이티브 이벤트 리스너를 사용하여 인바운드 메시지를 수신합니다.
- JS API (텍스트/미디어/링크) 를 통해 직접 응답을 보냅니다.
- Zalo Bot API 를 사용할 수 없는 "개인 계정" 사용 사례를 위해 설계되었습니다.

## ID 찾기 (디렉토리)

디렉토리 CLI 를 사용하여 피어/그룹과 ID 를 검색합니다:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 제한 사항

- 아웃바운드 텍스트는 약 2000 자로 청크됩니다 (Zalo 클라이언트 제한).
- 기본적으로 스트리밍이 차단됩니다.

## 접근 제어 (DM)

`channels.zalouser.dmPolicy` 지원: `pairing | allowlist | open | disabled` (기본값: `pairing`).

`channels.zalouser.allowFrom` 은 사용자 ID 나 이름을 허용합니다. 설정 중에 이름은 플러그인의 프로세스 내 연락처 조회를 사용하여 ID 로 확인됩니다.

승인:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## 그룹 접근 (선택)

- 기본값: `channels.zalouser.groupPolicy = "open"` (그룹 허용). 미설정 시 기본값을 재정의하려면 `channels.defaults.groupPolicy` 를 사용합니다.
- 허용 목록으로 제한:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (키는 안정적인 그룹 ID 여야 합니다. 이름은 시작 시 가능한 경우 ID 로 확인됩니다)
  - `channels.zalouser.groupAllowFrom` (허용된 그룹에서 봇을 트리거할 수 있는 발신자 제어)
- 모든 그룹 차단: `channels.zalouser.groupPolicy = "disabled"`.

### 그룹 멘션 게이팅

- `channels.zalouser.groups.<group>.requireMention` 은 그룹 응답에 멘션이 필요한지 제어합니다.
- 확인 순서: 정확한 그룹 id/이름 -> 정규화된 그룹 슬러그 -> `*` -> 기본값 (`true`).
- 이것은 허용 목록 그룹과 개방형 그룹 모드 모두에 적용됩니다.

## 다중 계정

계정은 OpenClaw 상태의 `zalouser` 프로필에 매핑됩니다. 예시:

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

## 타이핑, 리액션, 전달 확인

- OpenClaw 는 응답을 디스패치하기 전에 타이핑 이벤트를 보냅니다 (최선 노력).
- 메시지 리액션 액션 `react` 은 채널 액션에서 `zalouser` 에 대해 지원됩니다.
- 이벤트 메타데이터를 포함하는 인바운드 메시지의 경우 OpenClaw 는 전달 + 읽음 확인을 보냅니다 (최선 노력).

## 문제 해결

**로그인이 유지되지 않음:**

- `openclaw channels status --probe`
- 재로그인: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`

**허용 목록/그룹 이름이 확인되지 않음:**

- `allowFrom`/`groupAllowFrom`/`groups` 에 숫자 ID 또는 정확한 친구/그룹 이름을 사용합니다.

**이전 CLI 기반 설정에서 업그레이드:**

- 이전 외부 `zca` 프로세스 가정을 제거합니다.
- 채널은 이제 외부 CLI 바이너리 없이 OpenClaw 내에서 완전히 실행됩니다.
