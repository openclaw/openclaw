---
summary: "Zalo 개인 플러그인: zca-cli 를 통한 QR 로그인 + 메시징 (플러그인 설치 + 채널 설정 + CLI + 도구)"
read_when:
  - OpenClaw 에서 Zalo 개인(비공식) 지원이 필요할 때
  - zalouser 플러그인을 구성하거나 개발할 때
title: "Zalo 개인 플러그인"
---

# Zalo 개인 (플러그인)

`zca-cli` 를 사용하여 일반 Zalo 사용자 계정을 자동화하는 플러그인을 통해 OpenClaw 용 Zalo 개인 지원을 제공합니다.

> **경고:** 비공식 자동화는 계정 정지/차단으로 이어질 수 있습니다. 사용에 따른 위험은 본인 책임입니다.

## 이름 지정

채널 id 는 **개인 Zalo 사용자 계정**(비공식)을 자동화한다는 점을 명확히 하기 위해 `zalouser` 입니다. 향후 공식 Zalo API 통합 가능성을 위해 `zalo` 는 예약해 둡니다.

## 실행 위치

이 플러그인은 **Gateway(게이트웨이) 프로세스 내부**에서 실행됩니다.

원격 Gateway(게이트웨이)를 사용하는 경우, **Gateway(게이트웨이)를 실행하는 머신**에 설치/구성한 다음 Gateway(게이트웨이)를 재시작하십시오.

## 설치

### 옵션 A: npm 에서 설치

```bash
openclaw plugins install @openclaw/zalouser
```

이후 Gateway(게이트웨이)를 재시작하십시오.

### 옵션 B: 로컬 폴더에서 설치 (개발)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

이후 Gateway(게이트웨이)를 재시작하십시오.

## 사전 요구 사항: zca-cli

Gateway(게이트웨이) 머신에는 `PATH` 에서 `zca` 가 설치되어 있어야 합니다:

```bash
zca --version
```

## 설정

채널 설정은 `plugins.entries.*` 이 아니라 `channels.zalouser` 아래에 위치합니다:

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
