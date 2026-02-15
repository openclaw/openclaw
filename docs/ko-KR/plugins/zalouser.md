---
summary: "Zalo Personal plugin: QR login + messaging via zca-cli (plugin install + channel config + CLI + tool)"
read_when:
  - You want Zalo Personal (unofficial) support in OpenClaw
  - You are configuring or developing the zalouser plugin
title: "Zalo Personal Plugin"
x-i18n:
  source_hash: b29b788b023cd50720e24fe6719f02e9f86c8bca9c73b3638fb53c2316718672
---

# Zalo Personal (플러그인)

일반 Zalo 사용자 계정을 자동화하기 위해 `zca-cli`를 사용하여 플러그인을 통해 OpenClaw에 대한 Zalo Personal 지원.

> **경고:** 비공식 자동화로 인해 계정이 정지/금지될 수 있습니다. 자신의 책임하에 사용하십시오.

## 이름 지정

채널 ID는 `zalouser`입니다. 이는 **개인 Zalo 사용자 계정**(비공식)을 자동화합니다. 우리는 잠재적인 향후 공식 Zalo API 통합을 위해 `zalo`를 예약해 둡니다.

## 실행 위치

이 플러그인은 **게이트웨이 프로세스** 내에서 실행됩니다.

원격 게이트웨이를 사용하는 경우 **게이트웨이를 실행하는 컴퓨터**에 이를 설치/구성한 다음 게이트웨이를 다시 시작하세요.

## 설치

### 옵션 A: npm에서 설치

```bash
openclaw plugins install @openclaw/zalouser
```

나중에 게이트웨이를 다시 시작하십시오.

### 옵션 B: 로컬 폴더에서 설치(dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

나중에 게이트웨이를 다시 시작하십시오.

## 전제조건: zca-cli

게이트웨이 머신에는 `PATH`에 `zca`가 있어야 합니다.

```bash
zca --version
```

## 구성

채널 구성은 `channels.zalouser` 아래에 있습니다(`plugins.entries.*` 아님).

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
