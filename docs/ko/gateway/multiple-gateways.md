---
read_when:
    - 동일한 머신에서 둘 이상의 게이트웨이 실행
    - 게이트웨이당 격리된 구성/상태/포트가 필요합니다.
summary: 하나의 호스트(격리, 포트 및 프로필)에서 여러 OpenClaw 게이트웨이 실행
title: 다중 게이트웨이
x-i18n:
    generated_at: "2026-02-08T15:59:10Z"
    model: gtx
    provider: google-translate
    source_hash: 09b5035d4e5fb97c8d4596f7e23dea67224dad3b6d9e2c37ecb99840f28bd77d
    source_path: gateway/multiple-gateways.md
    workflow: 15
---

# 다중 게이트웨이(동일한 호스트)

단일 게이트웨이가 여러 메시징 연결과 에이전트를 처리할 수 있으므로 대부분의 설정에서는 하나의 게이트웨이를 사용해야 합니다. 더 강력한 격리 또는 중복성(예: 구조 봇)이 필요한 경우 격리된 프로필/포트가 있는 별도의 게이트웨이를 실행하세요.

## 격리 체크리스트(필수)

- `OPENCLAW_CONFIG_PATH` — 인스턴스별 구성 파일
- `OPENCLAW_STATE_DIR` — 인스턴스별 세션, 자격 증명, 캐시
- `agents.defaults.workspace` — 인스턴스별 작업공간 루트
- `gateway.port` (또는 `--port`) — 인스턴스별로 고유함
- 파생 포트(브라우저/캔버스)는 겹쳐서는 안 됩니다.

공유되면 구성 경합 및 포트 충돌이 발생합니다.

## 권장사항: 프로필(`--profile`)

프로필 자동 범위 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` 서비스 이름 뒤에 접미사를 붙입니다.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

프로필별 서비스:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## 구조봇 가이드

동일한 호스트에서 두 번째 게이트웨이를 자체적으로 실행합니다.

- 프로필/구성
- 주 디렉토리
- 작업 공간
- 기본 포트(파생 포트 포함)

이렇게 하면 구조 봇이 기본 봇과 격리되어 기본 봇이 다운된 경우 디버깅하거나 구성 변경 사항을 적용할 수 있습니다.

포트 간격: 파생된 브라우저/캔버스/CDP 포트가 충돌하지 않도록 기본 포트 사이에 최소 20개의 포트를 남겨 둡니다.

### 설치방법(구조봇)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## 포트 매핑(파생)

기본 포트 = `gateway.port` (또는 `OPENCLAW_GATEWAY_PORT` / `--port`).

- 브라우저 제어 서비스 포트 = 기본 + 2(루프백 전용)
- `canvasHost.port = base + 4`
- 브라우저 프로필 CDP 포트는 다음에서 자동 할당됩니다. `browser.controlPort + 9 .. + 108`

config 또는 env에서 이들 중 하나를 재정의하는 경우 인스턴스별로 고유하게 유지해야 합니다.

## 브라우저/CDP 노트(공통 풋건)

- 하다 **~ 아니다** 핀 `browser.cdpUrl` 여러 인스턴스에서 동일한 값으로.
- 각 인스턴스에는 자체 브라우저 제어 포트와 CDP 범위(해당 게이트웨이 포트에서 파생됨)가 필요합니다.
- 명시적인 CDP 포트가 필요한 경우 다음을 설정하십시오. `browser.profiles.<name>.cdpPort` 인스턴스 당.
- 원격 Chrome: 사용 `browser.profiles.<name>.cdpUrl` (프로필당, 인스턴스당).

## 수동 환경 예시

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## 빠른 점검

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
