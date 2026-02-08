---
read_when:
    - OpenClaw에서 Zalo Personal(비공식) 지원을 원합니다.
    - zaluser 플러그인을 구성 또는 개발 중입니다.
summary: 'Zalo 개인 플러그인: QR 로그인 + zca-cli를 통한 메시징(플러그인 설치 + 채널 구성 + CLI + 도구)'
title: Zalo 개인 플러그인
x-i18n:
    generated_at: "2026-02-08T16:07:54Z"
    model: gtx
    provider: google-translate
    source_hash: b29b788b023cd50720e24fe6719f02e9f86c8bca9c73b3638fb53c2316718672
    source_path: plugins/zalouser.md
    workflow: 15
---

# Zalo Personal(플러그인)

다음을 사용하여 플러그인을 통해 OpenClaw에 대한 Zalo Personal 지원 `zca-cli` 일반 Zalo 사용자 계정을 자동화합니다.

> **경고:** 비공식 자동화로 인해 계정이 정지/금지될 수 있습니다. 자신의 책임하에 사용하십시오.

## 명명

채널 ID는 다음과 같습니다. `zalouser` 이를 명시적으로 만들기 위해 다음을 자동화합니다. **개인 Zalo 사용자 계정** (비공식). 우리는 유지 `zalo` 잠재적인 향후 공식 Zalo API 통합을 위해 예약되어 있습니다.

## 실행되는 곳

이 플러그인이 실행됩니다 **게이트웨이 프로세스 내부**.

원격 게이트웨이를 사용하는 경우 이를 원격 게이트웨이에 설치/구성하세요. **게이트웨이를 실행하는 머신**을 누른 다음 게이트웨이를 다시 시작하십시오.

## 설치하다

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

게이트웨이 머신에는 다음이 있어야 합니다. `zca` ~에 `PATH`:

```bash
zca --version
```

## 구성

채널 구성은 다음과 같습니다. `channels.zalouser` (아니다 `plugins.entries.*`):

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

행위: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
