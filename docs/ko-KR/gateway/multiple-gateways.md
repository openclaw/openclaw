---
summary: "한 호스트에서 여러 OpenClaw Gateway 실행 (격리, 포트, 프로필)"
read_when:
  - 동일 머신에서 둘 이상의 Gateway를 실행할 때
  - Gateway별로 격리된 설정/상태/포트가 필요할 때
title: "여러 Gateway"
x-i18n:
  source_path: docs/gateway/multiple-gateways.md
---

# 여러 Gateway (동일 호스트)

하나의 Gateway가 여러 메시징 연결과 에이전트를 처리할 수 있으므로 대부분의 설정은 하나의 Gateway를 사용해야 합니다. 더 강력한 격리나 중복성이 필요한 경우 (예: 복구 봇), 격리된 프로필/포트로 별도의 Gateway를 실행합니다.

## 격리 체크리스트 (필수)

- `OPENCLAW_CONFIG_PATH` -- 인스턴스별 설정 파일
- `OPENCLAW_STATE_DIR` -- 인스턴스별 세션, 자격 증명, 캐시
- `agents.defaults.workspace` -- 인스턴스별 워크스페이스 루트
- `gateway.port` (또는 `--port`) -- 인스턴스별 고유
- 파생 포트 (브라우저/캔버스)가 겹치지 않아야 함

이것들이 공유되면, 설정 경쟁과 포트 충돌이 발생합니다.

## 권장: 프로필 (`--profile`)

프로필은 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`를 자동으로 범위 지정하고 서비스 이름에 접미사를 붙입니다.

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

## 복구 봇 가이드

동일 호스트에서 자체적인 것을 갖춘 두 번째 Gateway를 실행합니다:

- 프로필/설정
- 상태 디렉토리
- 워크스페이스
- 기본 포트 (파생 포트 포함)

이를 통해 복구 봇이 메인 봇이 다운된 경우 디버깅하거나 설정 변경을 적용할 수 있도록 메인 봇으로부터 격리됩니다.

포트 간격: 파생 브라우저/캔버스/CDP 포트가 절대 충돌하지 않도록 기본 포트 사이에 최소 20개 포트를 둡니다.

### 설치 방법 (복구 봇)

```bash
# 메인 봇 (기존 또는 새것, --profile 매개변수 없이)
# 포트 18789 + Chrome CDC/Canvas/... 포트에서 실행
openclaw onboard
openclaw gateway install

# 복구 봇 (격리된 프로필 + 포트)
openclaw --profile rescue onboard
# 참고:
# - 워크스페이스 이름은 기본적으로 -rescue 접미사가 붙음
# - 포트는 최소 18789 + 20 포트 이상이어야 함,
#   완전히 다른 기본 포트 선택이 더 좋음, 예: 19789,
# - 나머지 온보딩은 일반과 동일

# 서비스 설치 (설정 중 자동으로 발생하지 않은 경우)
openclaw --profile rescue gateway install
```

## 포트 매핑 (파생)

기본 포트 = `gateway.port` (또는 `OPENCLAW_GATEWAY_PORT` / `--port`).

- 브라우저 제어 서비스 포트 = 기본 + 2 (루프백 전용)
- 캔버스 호스트는 Gateway HTTP 서버에서 제공 (`gateway.port`와 동일한 포트)
- 브라우저 프로필 CDP 포트는 `browser.controlPort + 9 .. + 108`에서 자동 할당

이들 중 하나를 설정 또는 환경 변수로 재정의하는 경우, 인스턴스별로 고유하게 유지해야 합니다.

## 브라우저/CDP 참고 (일반적인 실수)

- 여러 인스턴스에서 `browser.cdpUrl`을 동일한 값으로 고정하지 **마세요**.
- 각 인스턴스에는 자체 브라우저 제어 포트와 CDP 범위가 필요합니다 (Gateway 포트에서 파생).
- 명시적 CDP 포트가 필요하면, 인스턴스별로 `browser.profiles.<name>.cdpPort`를 설정합니다.
- 원격 Chrome: `browser.profiles.<name>.cdpUrl`을 사용합니다 (프로필별, 인스턴스별).

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
