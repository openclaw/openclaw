---
summary: "Logging surfaces, file logs, WS log styles, and console formatting"
read_when:
  - Changing logging output or formats
  - Debugging CLI or gateway output
title: "Logging"
x-i18n:
  source_hash: efb8eda5e77e3809369a8ff569fac110323a86b3945797093f20e9bc98f39b2e
---

# 로깅

사용자 대상 개요(CLI + 제어 UI + 구성)는 [/logging](/logging)을 참조하세요.

OpenClaw에는 두 개의 로그 "표면"이 있습니다.

- **콘솔 출력**(터미널/디버그 UI에 표시되는 내용)
- 게이트웨이 로거가 작성한 **파일 로그**(JSON 줄)입니다.

## 파일 기반 로거

- 기본 롤링 로그 파일은 `/tmp/openclaw/` 아래에 있습니다(하루에 하나의 파일): `openclaw-YYYY-MM-DD.log`
  - 날짜는 게이트웨이 호스트의 현지 시간대를 사용합니다.
- 로그 파일 경로와 레벨은 `~/.openclaw/openclaw.json`를 통해 구성할 수 있습니다.
  - `logging.file`
  - `logging.level`

파일 형식은 한 줄에 하나의 JSON 개체입니다.

Control UI Logs 탭은 게이트웨이(`logs.tail`)를 통해 이 파일을 추적합니다.
CLI도 동일한 작업을 수행할 수 있습니다.

```bash
openclaw logs --follow
```

**자세한 정보와 로그 수준**

- **파일 로그**는 `logging.level`에 의해 독점적으로 제어됩니다.
- `--verbose`는 **콘솔 상세 정보**(및 WS 로그 스타일)에만 영향을 미칩니다. 그렇지 **않아**
  파일 로그 수준을 높입니다.
- 파일 로그에서 자세한 정보만 캡처하려면 `logging.level`를 `debug`로 설정하거나
  `trace`.

## 콘솔 캡처

CLI는 `console.log/info/warn/error/debug/trace`를 캡처하여 파일 로그에 기록합니다.
여전히 stdout/stderr로 인쇄하는 동안.

다음을 통해 콘솔의 자세한 정도를 독립적으로 조정할 수 있습니다.

- `logging.consoleLevel` (기본값 `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## 도구 요약 수정

자세한 도구 요약(예: `🛠️ Exec: ...`)은 민감한 토큰이 공격을 받기 전에 마스킹할 수 있습니다.
콘솔 스트림. 이는 **도구 전용**이며 파일 로그를 변경하지 않습니다.

- `logging.redactSensitive`: `off` | `tools` (기본값: `tools`)
- `logging.redactPatterns`: 정규식 문자열 배열(기본값 재정의)
  - 원시 정규식 문자열(자동 `gi`)을 사용하거나 사용자 정의 플래그가 필요한 경우 `/pattern/flags`를 사용하세요.
  - 일치 항목은 처음 6개 + 마지막 4개 문자(길이 >= 18)를 유지하여 마스크되며, 그렇지 않으면 `***`입니다.
  - 기본값에는 공통 키 할당, CLI 플래그, JSON 필드, 베어러 헤더, PEM 블록 및 널리 사용되는 토큰 접두사가 포함됩니다.

## 게이트웨이 WebSocket 로그

게이트웨이는 두 가지 모드로 WebSocket 프로토콜 로그를 인쇄합니다.

- **일반 모드(`--verbose` 없음)**: "흥미로운" RPC 결과만 인쇄됩니다.
  - 오류 (`ok=false`)
  - 느린 호출(기본 임계값: `>= 50ms`)
  - 구문 분석 오류
- **상세 모드(`--verbose`)**: 모든 WS 요청/응답 트래픽을 인쇄합니다.

### WS 로그 스타일

`openclaw gateway`는 게이트웨이별 스타일 스위치를 지원합니다.

- `--ws-log auto` (기본값): 일반 모드가 최적화됩니다. 자세한 모드는 압축 출력을 사용합니다.
- `--ws-log compact`: 장황한 경우 간결한 출력(요청/응답 쌍)
- `--ws-log full`: 장황한 경우 프레임당 전체 출력
- `--compact`: `--ws-log compact`의 별칭

예:

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## 콘솔 포맷(하위 시스템 로깅)

콘솔 포맷터는 **TTY를 인식**하며 접두사가 붙은 일관된 행을 인쇄합니다.
하위 시스템 로거는 출력을 그룹화하고 검색 가능한 상태로 유지합니다.

행동:

- 모든 줄의 **하위 시스템 접두사**(예: `[gateway]`, `[canvas]`, `[tailscale]`)
- **하위 시스템 색상**(하위 시스템별로 안정적) 및 레벨 색상 지정
- **출력이 TTY이거나 환경이 리치 터미널처럼 보일 때의 색상** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), `NO_COLOR` 준수
- **단축된 하위 시스템 접두사**: 선행 `gateway/` + `channels/` 삭제, 마지막 2개 세그먼트 유지(예: `whatsapp/outbound`)
- **하위 시스템별 하위 로거**(자동 접두사 + 구조화된 필드 `{ subsystem }`)
- **`logRaw()`** QR/UX 출력용(접두사 없음, 서식 없음)
- **콘솔 스타일**(예: `pretty | compact | json`)
- **콘솔 로그 레벨**은 파일 로그 레벨과 분리됨(`logging.level`가 `debug`/`trace`로 설정된 경우 파일은 전체 세부 정보를 유지함)
- **WhatsApp 메시지 본문**은 `debug`에 기록됩니다(`--verbose`를 사용하여 확인하세요).

이는 기존 파일 로그를 안정적으로 유지하는 동시에 대화형 출력을 검색 가능하게 만듭니다.
