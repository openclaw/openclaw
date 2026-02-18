---
summary: "Zalo Personal 플러그인: QR 로그인 + zca-cli를 통한 메시지 전송 (플러그인 설치 + 채널 설정 + CLI + 도구)"
read_when:
  - OpenClaw에서 Zalo Personal(비공식) 지원을 원하는 경우
  - zalouser 플러그인을 설정하거나 개발 중인 경우
title: "Zalo Personal 플러그인"
---

# Zalo Personal (플러그인)

Zalo Personal은 `zca-cli`를 사용하여 OpenClaw에 플러그인으로 지원되며, 일반 Zalo 사용자 계정을 자동화합니다.

> **경고:** 비공식 자동화는 계정 정지/차단을 초래할 수 있습니다. 사용자는 본인의 책임 하에 사용하십시오.

## 네이밍

채널 ID는 `zalouser`로, 이것이 **개인 Zalo 사용자 계정**(비공식)을 자동화함을 명확히 합니다. 잠재적인 공식 Zalo API 통합을 위해 `zalo`는 예약됩니다.

## 실행 위치

이 플러그인은 **게이트웨이 프로세스 내부**에서 실행됩니다.

원격 게이트웨이를 사용하는 경우, **게이트웨이를 실행하는 컴퓨터**에 설치/구성한 후 게이트웨이를 재시작해야 합니다.

## 설치

### 옵션 A: npm에서 설치

```bash
openclaw plugins install @openclaw/zalouser
```

그 후 게이트웨이를 재시작하십시오.

### 옵션 B: 로컬 폴더에서 설치 (개발용)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

그 후 게이트웨이를 재시작하십시오.

## 필요 조건: zca-cli

게이트웨이 머신에는 `zca`가 `PATH`에 있어야 합니다:

```bash
zca --version
```

## 설정

채널 설정은 `channels.zalouser`에 있으며, `plugins.entries.*`에는 없습니다:

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

작업: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
