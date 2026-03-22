---
summary: "로깅 표면, 파일 로그, WS 로그 스타일, 콘솔 포맷팅"
read_when:
  - 로깅 출력 또는 형식을 변경할 때
  - CLI 또는 Gateway 출력을 디버깅할 때
title: "로깅"
x-i18n:
  source_path: docs/gateway/logging.md
---

# 로깅

사용자 대면 개요 (CLI + Control UI + 설정)는 [/logging](/logging)을 참고하세요.

OpenClaw에는 두 가지 로그 "표면"이 있습니다:

- **콘솔 출력** (터미널 / 디버그 UI에서 보이는 것).
- **파일 로그** (JSON 라인) Gateway 로거에 의해 작성됨.

## 파일 기반 로거

- 기본 롤링 로그 파일은 `/tmp/openclaw/` 아래에 있습니다 (하루에 한 파일): `openclaw-YYYY-MM-DD.log`
  - 날짜는 Gateway 호스트의 로컬 시간대를 사용합니다.
- 로그 파일 경로와 레벨은 `~/.openclaw/openclaw.json`을 통해 설정할 수 있습니다:
  - `logging.file`
  - `logging.level`

파일 형식은 줄당 하나의 JSON 객체입니다.

Control UI 로그 탭은 Gateway (`logs.tail`)를 통해 이 파일을 tail합니다.
CLI도 동일하게 할 수 있습니다:

```bash
openclaw logs --follow
```

**Verbose vs. 로그 레벨**

- **파일 로그**는 `logging.level`에 의해서만 제어됩니다.
- `--verbose`는 **콘솔 상세도** (및 WS 로그 스타일)에만 영향을 미칩니다. 파일 로그 레벨을 **높이지 않습니다**.
- 파일 로그에 verbose 전용 세부 정보를 캡처하려면, `logging.level`을 `debug` 또는 `trace`로 설정합니다.

## 콘솔 캡처

CLI는 `console.log/info/warn/error/debug/trace`를 캡처하여 파일 로그에 기록하면서 stdout/stderr에도 출력합니다.

콘솔 상세도를 독립적으로 조정할 수 있습니다:

- `logging.consoleLevel` (기본값 `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## 도구 요약 편집

Verbose 도구 요약 (예: `Exec: ...`)은 콘솔 스트림에 도달하기 전에 민감한 토큰을 마스킹할 수 있습니다. 이것은 **도구 전용**이며 파일 로그는 변경하지 않습니다.

- `logging.redactSensitive`: `off` | `tools` (기본값: `tools`)
- `logging.redactPatterns`: 정규식 문자열 배열 (기본값 재정의)
  - 원시 정규식 문자열 (자동 `gi`) 또는 커스텀 플래그가 필요하면 `/pattern/flags`를 사용합니다.
  - 일치 항목은 처음 6 + 마지막 4 문자를 유지하여 마스킹됩니다 (길이 >= 18), 그 외 `***`.
  - 기본값은 일반적인 키 할당, CLI 플래그, JSON 필드, 베어러 헤더, PEM 블록, 인기 토큰 접두사를 포함합니다.

## Gateway WebSocket 로그

Gateway는 두 가지 모드로 WebSocket 프로토콜 로그를 출력합니다:

- **일반 모드 (`--verbose` 없음)**: "흥미로운" RPC 결과만 출력됩니다:
  - 오류 (`ok=false`)
  - 느린 호출 (기본 임계값: `>= 50ms`)
  - 파싱 오류
- **Verbose 모드 (`--verbose`)**: 모든 WS 요청/응답 트래픽을 출력합니다.

### WS 로그 스타일

`openclaw gateway`는 Gateway별 스타일 스위치를 지원합니다:

- `--ws-log auto` (기본값): 일반 모드는 최적화됨; verbose 모드는 compact 출력 사용
- `--ws-log compact`: verbose 시 compact 출력 (페어링된 요청/응답)
- `--ws-log full`: verbose 시 전체 프레임별 출력
- `--compact`: `--ws-log compact`의 별칭

예시:

```bash
# 최적화 (오류/느린 것만)
openclaw gateway

# 모든 WS 트래픽 표시 (페어링)
openclaw gateway --verbose --ws-log compact

# 모든 WS 트래픽 표시 (전체 메타)
openclaw gateway --verbose --ws-log full
```

## 콘솔 포맷팅 (서브시스템 로깅)

콘솔 포매터는 **TTY 인식**이며 일관된 접두사가 붙은 줄을 출력합니다.
서브시스템 로거는 출력을 그룹화하고 스캔 가능하게 유지합니다.

동작:

- 모든 줄에 **서브시스템 접두사** (예: `[gateway]`, `[canvas]`, `[tailscale]`)
- **서브시스템 색상** (서브시스템별 안정) 및 레벨 색상
- **TTY이거나 환경이 리치 터미널처럼 보일 때 색상** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), `NO_COLOR` 존중
- **축약된 서브시스템 접두사**: 선행 `gateway/` + `channels/`를 제거하고 마지막 2 세그먼트 유지 (예: `whatsapp/outbound`)
- **서브시스템별 서브 로거** (자동 접두사 + 구조화된 필드 `{ subsystem }`)
- QR/UX 출력을 위한 **`logRaw()`** (접두사 없음, 포맷팅 없음)
- **콘솔 스타일** (예: `pretty | compact | json`)
- 파일 로그 레벨과 별개인 **콘솔 로그 레벨** (`logging.level`이 `debug`/`trace`로 설정되면 파일은 전체 세부 정보 유지)
- **WhatsApp 메시지 본문**은 `debug`에서 로깅됩니다 (보려면 `--verbose` 사용)

이를 통해 기존 파일 로그를 안정적으로 유지하면서 대화형 출력을 스캔 가능하게 만듭니다.
