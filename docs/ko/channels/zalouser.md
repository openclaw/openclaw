---
read_when:
    - OpenClaw용 Zalo Personal 설정
    - Zalo 개인 로그인 또는 메시지 흐름 디버깅
summary: zca-cli(QR 로그인), 기능 및 구성을 통한 Zalo 개인 계정 지원
title: Zalo 개인
x-i18n:
    generated_at: "2026-02-08T15:52:16Z"
    model: gtx
    provider: google-translate
    source_hash: ede847ebe62722568f8d24d0257986abaad539ecef96183ab0e83bbe6e6dc078
    source_path: channels/zalouser.md
    workflow: 15
---

# Zalo 개인 (비공식)

상태: 실험적. 이 통합은 **개인 Zalo 계정** ~을 통해 `zca-cli`.

> **경고:** 이는 비공식 통합이므로 계정이 정지/금지될 수 있습니다. 자신의 책임하에 사용하십시오.

## 플러그인 필요

Zalo Personal은 플러그인으로 제공되며 핵심 설치와 함께 번들로 제공되지 않습니다.

- CLI를 통해 설치: `openclaw plugins install @openclaw/zalouser`
- 또는 소스 체크아웃에서: `openclaw plugins install ./extensions/zalouser`
- 세부: [플러그인](/tools/plugin)

## 전제조건: zca-cli

게이트웨이 머신에는 다음이 있어야 합니다. `zca` 사용 가능한 바이너리 `PATH`.

- 확인하다: `zca --version`
- 누락된 경우 zca-cli를 설치합니다(참조 `extensions/zalouser/README.md` 또는 업스트림 zca-cli 문서).

## 빠른 설정(초보자)

1. 플러그인을 설치합니다(위 참조).
2. 로그인(QR, 게이트웨이 시스템):
   - `openclaw channels login --channel zalouser`
   - Zalo 모바일 앱을 사용하여 단말기의 QR 코드를 스캔하세요.
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

4. 게이트웨이를 다시 시작합니다(또는 온보딩을 완료합니다).
5. DM 액세스는 기본적으로 페어링으로 설정됩니다. 첫 번째 연락 시 페어링 코드를 승인하세요.

## 그것은 무엇입니까

- 용도 `zca listen` 인바운드 메시지를 수신합니다.
- 용도 `zca msg ...` 답장을 보내려면(텍스트/미디어/링크)
- Zalo Bot API를 사용할 수 없는 "개인 계정" 사용 사례를 위해 설계되었습니다.

## 명명

채널 ID는 다음과 같습니다. `zalouser` 이를 명시적으로 만들기 위해 다음을 자동화합니다. **개인 Zalo 사용자 계정** (비공식). 우리는 유지 `zalo` 잠재적인 향후 공식 Zalo API 통합을 위해 예약되어 있습니다.

## ID 찾기(디렉토리)

디렉터리 CLI를 사용하여 피어/그룹 및 해당 ID를 검색합니다.

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 제한

- 아웃바운드 텍스트는 최대 2000자로 청크됩니다(Zalo 클라이언트 제한).
- 스트리밍은 기본적으로 차단됩니다.

## 액세스 제어(DM)

`channels.zalouser.dmPolicy` 지원: `pairing | allowlist | open | disabled` (기본: `pairing`).
`channels.zalouser.allowFrom` 사용자 ID 또는 이름을 허용합니다. 마법사는 다음을 통해 이름을 ID로 확인합니다. `zca friend find` 가능한 경우.

승인 방법:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## 그룹 액세스(선택사항)

- 기본: `channels.zalouser.groupPolicy = "open"` (그룹 허용). 사용 `channels.defaults.groupPolicy` 설정되지 않은 경우 기본값을 재정의합니다.
- 다음을 사용하여 허용 목록으로 제한합니다.
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (키는 그룹 ID 또는 이름입니다)
- 모든 그룹 차단: `channels.zalouser.groupPolicy = "disabled"`.
- 구성 마법사는 그룹 허용 목록을 묻는 메시지를 표시할 수 있습니다.
- 시작 시 OpenClaw는 허용 목록의 그룹/사용자 이름을 ID로 확인하고 매핑을 기록합니다. 해결되지 않은 항목은 입력한 대로 유지됩니다.

예:

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

계정은 zca 프로필에 매핑됩니다. 예:

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

**`zca` 찾을 수 없음:**

- zca-cli를 설치하고 켜져 있는지 확인하세요. `PATH` 게이트웨이 프로세스의 경우.

**로그인이 유지되지 않습니다:**

- `openclaw channels status --probe`
- 다시 로그인: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
