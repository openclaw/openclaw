---
summary: "Zalo Personal 플러그인: QR 로그인 + 네이티브 zca-js 를 통한 메시징 (플러그인 설치 + 채널 구성 + 도구)"
read_when:
  - OpenClaw 에서 Zalo Personal (비공식) 지원을 원할 때
  - zalouser 플러그인을 구성하거나 개발할 때
title: "Zalo Personal 플러그인"
x-i18n:
  source_path: docs/plugins/zalouser.md
---

# Zalo Personal (플러그인)

네이티브 `zca-js`를 사용하여 일반 Zalo 사용자 계정을 자동화하는 플러그인을 통한 OpenClaw 의 Zalo Personal 지원입니다.

> **경고:** 비공식 자동화는 계정 정지/차단으로 이어질 수 있습니다. 자기 책임 하에 사용하세요.

## 이름 규칙

**개인 Zalo 사용자 계정** (비공식) 을 자동화한다는 것을 명시하기 위해 채널 ID 는 `zalouser`입니다. 향후 공식 Zalo API 통합을 위해 `zalo`는 예약되어 있습니다.

## 실행 위치

이 플러그인은 **Gateway 프로세스 내부에서** 실행됩니다.

원격 Gateway 를 사용하는 경우 **Gateway 를 실행하는 머신에서** 설치/구성한 다음 Gateway 를 재시작하세요.

외부 `zca`/`openzca` CLI 바이너리가 필요하지 않습니다.

## 설치

### 옵션 A: npm 에서 설치

```bash
openclaw plugins install @openclaw/zalouser
```

이후 Gateway 를 재시작하세요.

### 옵션 B: 로컬 폴더에서 설치 (개발)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

이후 Gateway 를 재시작하세요.

## 구성

채널 구성은 `channels.zalouser` 아래에 있습니다 (`plugins.entries.*`가 아님):

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

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## 에이전트 도구

도구 이름: `zalouser`

액션: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`

채널 메시지 액션은 메시지 리액션을 위한 `react`도 지원합니다.
