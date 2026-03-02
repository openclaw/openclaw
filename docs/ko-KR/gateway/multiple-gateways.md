---
summary: "동일 호스트에서 여러 OpenClaw Gateway 실행(고립, 포트 및 프로파일)"
read_when:
  - 동일 머신에서 둘 이상의 Gateway 실행
  - 게이트웨이당 고립된 설정/상태/포트 필요
title: "다중 게이트웨이"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/multiple-gateways.md
  workflow: 15
---

# 다중 게이트웨이(동일 호스트)

대부분의 설정은 하나의 게이트웨이를 사용해야 합니다. 단일 게이트웨이는 여러 메시징 연결과 에이전트를 처리할 수 있습니다. 더 강한 고립 또는 중복성(예: 구조 유지 봇)이 필요하면 고립된 프로파일/포트로 별도의 Gateway를 실행합니다.

## 고립 체크리스트(필수)

- `OPENCLAW_CONFIG_PATH` — 인스턴스별 설정 파일
- `OPENCLAW_STATE_DIR` — 인스턴스별 세션, creds, 캐시
- `agents.defaults.workspace` — 인스턴스별 작업 공간 루트
- `gateway.port` (또는 `--port`) — 인스턴스별 고유
- 파생 포트(브라우저/캔버스)는 겹치지 않아야 함

이를 공유하면 설정 경합과 포트 충돌이 발생합니다.

## 권장: 프로파일(`--profile`)

프로파일은 자동으로 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`를 범위 지정하고 서비스 이름을 접미사합니다.

```bash
# 메인
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

## 구조 유지 봇 가이드

동일 호스트에서 두 번째 게이트웨이를 실행하되 다음을 격리합니다:

- 프로파일/설정
- 상태 디렉토리
- 작업 공간
- 기본 포트(+ 파생 포트)

이는 구조 유지 봇이 주 봇과 격리되므로 주 봇이 다운되는 경우 설정을 디버그하거나 적용할 수 있습니다.

포트 간격: 기본 포트 사이에 최소 20개 포트를 남겨두세요. 파생 브라우저/캔버스/CDP 포트가 충돌하지 않도록 합니다.

### 설치 방법(구조 유지 봇)

```bash
# 주 봇(기존 또는 새로움, --profile 매개변수 없음)
# 포트 18789 + Chrome CDC/Canvas/... 포트에서 실행
openclaw onboard
openclaw gateway install

# 구조 유지 봇(격리된 프로파일 + 포트)
openclaw --profile rescue onboard
# 참고:
# - 작업 공간 이름은 기본적으로 -rescue 접미사가 붙습니다
# - 포트는 최소한 18789 + 20 포트여야 합니다,
#   더 나은 것은 완전히 다른 기본 포트를 선택하는 것입니다(예: 19789).
# - 나머지 온보딩은 정상과 동일합니다

# 서비스 설치(온보딩 중 발생하지 않은 경우)
openclaw --profile rescue gateway install
```

## 포트 매핑(파생)

기본 포트 = `gateway.port` (또는 `OPENCLAW_GATEWAY_PORT` / `--port`).

- 브라우저 제어 서비스 포트 = base + 2 (루프백만)
- 캔버스 호스트는 게이트웨이 HTTP 서버에서 제공됩니다(동일 포트 `gateway.port`)
- 브라우저 프로파일 CDP 포트는 `browser.controlPort + 9 .. + 108`에서 자동 할당됩니다

config 또는 env에서 이를 재정의하면 인스턴스별로 고유하게 유지해야 합니다.

## 브라우저/CDP 참고(일반적 footgun)

- 여러 인스턴스에서 `browser.cdpUrl`을 동일한 값으로 고정하지 마세요.
- 각 인스턴스는 자체 브라우저 제어 포트 및 CDP 범위(게이트웨이 포트에서 파생)가 필요합니다.
- 명시적 CDP 포트가 필요하면 인스턴스별로 `browser.profiles.<name>.cdpPort`를 설정하세요.
- 원격 Chrome: 인스턴스별로 `browser.profiles.<name>.cdpUrl`을 사용하세요.

## 수동 env 예제

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## 빠른 검사

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
