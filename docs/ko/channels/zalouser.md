---
summary: "zca-cli(QR 로그인)를 통한 Zalo 개인 계정 지원, 기능 및 구성"
read_when:
  - OpenClaw용 Zalo Personal 설정
  - Zalo Personal 로그인 또는 메시지 흐름 디버깅
title: "Zalo Personal"
---

# Zalo Personal (비공식)

상태: 실험적. 이 통합은 `zca-cli` 를 통해 **Zalo 개인 계정**을 자동화합니다.

> **경고:** 이는 비공식 통합이며 계정 정지/차단으로 이어질 수 있습니다. 사용에 따른 책임은 사용자에게 있습니다.

## 필요한 플러그인

Zalo Personal 은 플러그인으로 제공되며 코어 설치에 번들되어 있지 않습니다.

- CLI 를 통해 설치: `openclaw plugins install @openclaw/zalouser`
- 또는 소스 체크아웃에서 설치: `openclaw plugins install ./extensions/zalouser`
- 세부 정보: [Plugins](/tools/plugin)

## 사전 요구 사항: zca-cli

Gateway(게이트웨이) 머신에는 `zca` 바이너리가 `PATH` 에서 사용 가능해야 합니다.

- 확인: `zca --version`
- 없을 경우 zca-cli 를 설치하십시오(`extensions/zalouser/README.md` 또는 상위 zca-cli 문서 참고).

## 빠른 설정 (초보자)

1. 플러그인을 설치합니다(위 참조).
2. 로그인(QR, Gateway(게이트웨이) 머신에서):
   - `openclaw channels login --channel zalouser`
   - 터미널에 표시된 QR 코드를 Zalo 모바일 앱으로 스캔합니다.
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

4. Gateway(게이트웨이)를 재시작합니다(또는 온보딩을 완료합니다).
5. 최초 접촉 시 페어링 코드를 승인하십시오.

## 무엇인가

- `zca listen` 를 사용하여 수신 메시지를 수신합니다.
- `zca msg ...` 를 사용하여 응답(텍스트/미디어/링크)을 전송합니다.
- Zalo Bot API 를 사용할 수 없는 “개인 계정” 사용 사례를 위해 설계되었습니다.

## 이름 지정

채널 id 는 비공식 **Zalo 개인 사용자 계정** 자동화임을 명확히 하기 위해 `zalouser` 입니다. 향후 공식 Zalo API 통합 가능성을 위해 `zalo` 는 예약해 둡니다.

## ID 찾기(디렉토리)

디렉토리 CLI 를 사용하여 상대/그룹과 해당 ID 를 탐색할 수 있습니다:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 제한 사항

- 발신 텍스트는 Zalo 클라이언트 제한으로 인해 약 2000 자 단위로 분할됩니다.
- 스트리밍은 기본적으로 차단됩니다.

## 접근 제어(다이렉트 메시지)

`channels.zalouser.dmPolicy` 은 `pairing | allowlist | open | disabled` 를 지원합니다(기본값: `pairing`).
`channels.zalouser.allowFrom` 는 사용자 ID 또는 이름을 허용합니다. 마법사는 가능할 경우 `zca friend find` 를 통해 이름을 ID 로 해석합니다.

다음을 통해 승인합니다:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## 그룹 접근(선택 사항)

- 기본값: `channels.zalouser.groupPolicy = "open"` (그룹 허용). 미설정 시 기본값을 재정의하려면 `channels.defaults.groupPolicy` 를 사용하십시오.
- 허용 목록으로 제한:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (키는 그룹 ID 또는 이름)
- 모든 그룹 차단: `channels.zalouser.groupPolicy = "disabled"`.
- 구성 마법사는 그룹 허용 목록을 묻는 프롬프트를 제공할 수 있습니다.
- 시작 시 OpenClaw 는 허용 목록의 그룹/사용자 이름을 ID 로 해석하고 매핑을 로그에 기록합니다. 해석되지 않은 항목은 입력된 그대로 유지됩니다.

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

**`zca` 를 찾을 수 없음:**

- zca-cli 를 설치하고 Gateway(게이트웨이) 프로세스에 대해 `PATH` 에 포함되어 있는지 확인하십시오.

**로그인이 유지되지 않음:**

- `openclaw channels status --probe`
- 다시 로그인: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
