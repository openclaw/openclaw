---
summary: "하나의 호스트에서 여러 OpenClaw Gateway(게이트웨이)를 실행합니다(격리, 포트, 프로파일)"
read_when:
  - 동일한 머신에서 둘 이상의 Gateway(게이트웨이)를 실행하는 경우
  - Gateway(게이트웨이)별로 격리된 구성/상태/포트가 필요한 경우
title: "다중 Gateway(게이트웨이)"
---

# 다중 Gateway(게이트웨이) (동일 호스트)

대부분의 설정에서는 하나의 Gateway(게이트웨이)를 사용하는 것이 좋습니다. 단일 Gateway(게이트웨이)로 여러 메시징 연결과 에이전트를 처리할 수 있기 때문입니다. 더 강한 격리나 중복성(예: 구조용 봇)이 필요하다면, 격리된 프로파일/포트를 사용하는 별도의 Gateway(게이트웨이)를 실행하십시오.

## 격리 체크리스트 (필수)

- `OPENCLAW_CONFIG_PATH` — 인스턴스별 구성 파일
- `OPENCLAW_STATE_DIR` — 인스턴스별 세션, 자격 증명, 캐시
- `agents.defaults.workspace` — 인스턴스별 작업 공간 루트
- `gateway.port` (또는 `--port`) — 인스턴스별로 고유해야 함
- Derived ports (browser/canvas) must not overlap

이 항목들이 공유되면 구성 경합과 포트 충돌이 발생합니다.

## 권장: 프로파일 (`--profile`)

프로파일은 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` 를 자동으로 범위 지정하고 서비스 이름에 접미사를 붙입니다.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

프로파일별 서비스:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Rescue-bot guide

동일한 호스트에서 다음 항목을 각각 분리하여 두 번째 Gateway(게이트웨이)를 실행하십시오.

- 프로파일/구성
- state dir
- 작업 공간
- 기본 포트(및 파생 포트)

이렇게 하면 주 봇이 중단되었을 때 구조용 봇이 디버그하거나 구성 변경을 적용할 수 있도록 주 봇과 격리됩니다.

포트 간격: 파생된 브라우저/캔버스/CDP 포트가 절대 충돌하지 않도록 기본 포트 사이에 최소 20개의 포트를 두십시오.

### 설치 방법 (구조용 봇)

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

## 포트 매핑 (파생)

기본 포트 = `gateway.port` (또는 `OPENCLAW_GATEWAY_PORT` / `--port`).

- 브라우저 제어 서비스 포트 = 기본 + 2 (local loopback 전용)
- `canvasHost.port = base + 4`
- 브라우저 프로파일 CDP 포트는 `browser.controlPort + 9 .. + 108` 에서 자동 할당됨

구성 또는 환경 변수에서 이들 중 어떤 항목이든 재정의하는 경우, 인스턴스별로 고유성을 유지해야 합니다.

## 브라우저/CDP 참고 사항 (자주 발생하는 실수)

- 여러 인스턴스에서 `browser.cdpUrl` 을 동일한 값으로 고정하지 마십시오.
- 각 인스턴스에는 자체 브라우저 제어 포트와 CDP 범위(게이트웨이 포트에서 파생됨)가 필요합니다.
- 명시적인 CDP 포트가 필요하다면 인스턴스별로 `browser.profiles.<name>.cdpPort` 를 설정하십시오.
- 원격 Chrome: `browser.profiles.<name>.cdpUrl` 을 사용하십시오(프로파일별, 인스턴스별).

## 수동 환경 변수 예시

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
