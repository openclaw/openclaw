---
summary: "Zalo Personal 플러그인: QR 로그인 + zca-cli를 통한 메시징 (플러그인 설치 + 채널 구성 + CLI + 도구)"
read_when:
  - "OpenClaw에서 Zalo Personal (비공식) 지원을 원할 때"
  - "zalouser 플러그인을 구성하거나 개발할 때"
title: "Zalo Personal 플러그인"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/plugins/zalouser.md
  workflow: 15
---

# Zalo Personal (플러그인)

플러그인을 통한 OpenClaw용 Zalo Personal 지원 (`zca-cli`를 사용하여 일반 Zalo 사용자 계정 자동화).

> **경고:** 비공식 자동화는 계정 일시 중단/금지로 이어질 수 있습니다. 자신의 위험에 사용합니다.

## 명명

채널 id는 `zalouser`이어서 이것이 **개인 Zalo 사용자 계정**을 자동화합니다 (비공식). 잠재적인 공식 Zalo API 통합을 위해 `zalo`를 예약합니다.

## 실행 위치

이 플러그인은 **Gateway 프로세스 내에서 실행**합니다.

원격 Gateway를 사용하면 **Gateway를 실행하는 머신에 설치/구성**한 다음 Gateway를 다시 시작합니다.

## 설치

### 옵션 A: npm에서 설치

```bash
openclaw plugins install @openclaw/zalouser
```

그 후 Gateway를 다시 시작합니다.

### 옵션 B: 로컬 폴더에서 설치 (개발)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

그 후 Gateway를 다시 시작합니다.

## 전제 조건: zca-cli

Gateway 머신은 `PATH`에 `zca`를 가져야 합니다:

```bash
zca --version
```

## 구성

채널 구성은 `channels.zalouser` 아래에 있습니다 (`plugins.entries.*` 아님):

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

## Agent 도구

도구 이름: `zalouser`

작업: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
