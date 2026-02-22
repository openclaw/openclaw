---
summary: "하나의 호스트에서 여러 OpenClaw 게이트웨이 실행 (격리, 포트 및 프로필)"
read_when:
  - 동일한 머신에서 두 개 이상의 게이트웨이를 실행할 때
  - 게이트웨이별로 격리된 설정/상태/포트가 필요할 때
title: "다중 게이트웨이"
---

# 다중 게이트웨이 (동일 호스트)

일반적으로 하나의 게이트웨이를 사용하는 것이 좋습니다. 하나의 게이트웨이는 여러 메시징 연결과 에이전트를 처리할 수 있습니다. 더 강력한 격리 또는 중복성이 필요한 경우(예: 구조 봇), 격리된 프로필/포트를 사용하여 별도의 게이트웨이를 실행하세요.

## 격리 체크리스트 (필수)

- `OPENCLAW_CONFIG_PATH` — 인스턴스별 설정 파일
- `OPENCLAW_STATE_DIR` — 인스턴스별 세션, 인증 정보, 캐시
- `agents.defaults.workspace` — 인스턴스별 작업 공간 루트
- `gateway.port` (또는 `--port`) — 인스턴스별 고유 포트
- 파생 포트 (브라우저/캔버스)가 중첩되지 않아야 함

이들이 공유되면 설정 경합과 포트 충돌이 발생합니다.

## 권장 방법: 프로필 (`--profile`)

프로필은 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`를 자동으로 범위 지정하고 서비스 이름에 접미사를 붙입니다.

```bash
# 메인
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# 구조
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

프로필별 서비스:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## 구조 봇 가이드

같은 호스트에서 두 번째 게이트웨이를 다음 항목이 각각 독립적으로 구성된 상태로 실행합니다:

- 프로필/설정
- 상태 디렉터리
- 작업 공간
- 기본 포트 (및 파생 포트)

이를 통해 주 게이트웨이가 다운되었을 때 구조 봇이 격리된 상태에서 디버그를 수행하거나 설정 변경을 적용할 수 있습니다.

포트 간격: 파생 브라우저/캔버스/CDP 포트가 충돌하지 않도록 기본 포트 간에 최소 20개의 포트를 남겨두세요.

### 설치 방법 (구조 봇)

```bash
# 메인 봇 (기존 또는 신규, --profile 파라미터 없이)
# 포트 18789 + Chrome CDC/Canvas/... 포트에서 실행됩니다
openclaw onboard
openclaw gateway install

# 구조 봇 (격리된 프로필 + 포트)
openclaw --profile rescue onboard
# 참고:
# - 작업 공간 이름은 기본적으로 -rescue 접미사가 붙습니다
# - 포트는 최소 18789 + 20 이상이어야 하며,
#   19789와 같이 완전히 다른 기본 포트를 선택하는 것이 좋습니다
# - 나머지 온보딩 과정은 일반과 동일합니다

# 서비스 설치 (온보딩 중 자동으로 이루어지지 않은 경우)
openclaw --profile rescue gateway install
```

## 포트 매핑 (파생)

기본 포트 = `gateway.port` (또는 `OPENCLAW_GATEWAY_PORT` / `--port`).

- 브라우저 제어 서비스 포트 = 기본값 + 2 (루프백 전용)
- 캔버스 호스트는 게이트웨이 HTTP 서버에서 제공됩니다 (포트는 `gateway.port`와 동일)
- 브라우저 프로필 CDP 포트는 `browser.controlPort + 9 .. + 108`에서 자동 할당됩니다

설정 또는 환경 변수에서 이 중 하나를 재정의할 경우 인스턴스별로 고유하게 유지해야 합니다.

## 브라우저/CDP 주의사항 (흔한 실수)

- 여러 인스턴스에서 `browser.cdpUrl`을 동일한 값으로 고정하지 마십시오.
- 각 인스턴스는 자체 브라우저 제어 포트와 CDP 범위(게이트웨이 포트에서 파생)를 필요로 합니다.
- 명시적인 CDP 포트가 필요한 경우, 인스턴스별로 `browser.profiles.<name>.cdpPort`를 설정하세요.
- 원격 Chrome: `browser.profiles.<name>.cdpUrl`을 사용하세요 (프로필별, 인스턴스별).

## 수동 환경 변수 예시

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## 빠른 확인

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
