---
summary: "로깅 표면, 파일 로그, WS 로그 스타일 및 콘솔 형식화"
read_when:
  - 로깅 출력 또는 형식을 변경할 때
  - CLI 또는 Gateway 출력을 디버깅할 때
title: "로깅"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/logging.md
  workflow: 15
---

# 로깅

사용자 대면 개요 (CLI + Control UI + 구성) 는 [/logging](/logging) 를 참조하세요.

OpenClaw 는 두 개의 로그 "표면" 을 가집니다:

- **콘솔 출력** (터미널/디버그 UI 에서 보는 것).
- **파일 로그** (JSON 라인) Gateway 로거가 작성함.

## 파일 기반 로거

- 기본 롤링 로그 파일은 `/tmp/openclaw/` (일일 파일) 에 있습니다: `openclaw-YYYY-MM-DD.log`
  - 날짜는 Gateway 호스트의 로컬 시간대를 사용합니다.
- 로그 파일 경로 및 레벨은 `~/.openclaw/openclaw.json` 을 통해 구성할 수 있습니다:
  - `logging.file`
  - `logging.level`

파일 형식은 한 줄에 하나의 JSON 객체입니다.

Control UI Logs 탭은 Gateway (`logs.tail`) 를 통해 이 파일을 추적합니다.
CLI 도 동일하게 할 수 있습니다:

```bash
openclaw logs --follow
```

**Verbose 대 로그 레벨**

- **파일 로그** 는 `logging.level` 로만 제어됩니다.
- `--verbose` 는 **콘솔 일반성** (그리고 WS 로그 스타일) 에만 영향을 미칩니다; **파일 로그 레벨을 올리지 않습니다**.
- 파일 로그에서 verbose 전용 세부 사항을 캡처하려면 `logging.level` 을 `debug` 또는 `trace` 로 설정합니다.

## 콘솔 캡처

CLI 는 `console.log/info/warn/error/debug/trace` 를 캡처하고 파일 로그에 작성합니다,
stdout/stderr 에 출력하는 동안 계속.

콘솔 일반성을 통해 독립적으로 조정할 수 있습니다:

- `logging.consoleLevel` (기본값 `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## 도구 요약 편집

자세한 도구 요약 (예: `🛠️ Exec: ...`) 은 콘솔 스트림에 도달하기 전에 민감한 토큰을 마스킹할 수 있습니다. 이는 **도구 전용** 이며 파일 로그를 변경하지 않습니다.

- `logging.redactSensitive`: `off` | `tools` (기본값: `tools`)
- `logging.redactPatterns`: 정규 표현식 문자열 배열 (기본값 오버라이드)
  - raw 정규 표현식 문자열 사용 (auto `gi`), 또는 사용자 정의 플래그가 필요한 경우 `/pattern/flags`.
  - 일치는 마스킹됩니다 (길이 >= 18 이면 처음 6 + 마지막 4 자 유지, 그 외 `***`).
  - 기본값은 일반 키 할당, CLI 플래그, JSON 필드, bearer 헤더, PEM 블록 및 인기 있는 토큰 접두사를 다룹니다.

## Gateway WebSocket 로그

Gateway 는 두 가지 모드에서 WebSocket 프로토콜 로그를 인쇄합니다:

- **정상 모드 (no `--verbose`)**: "흥미로운" RPC 결과만 인쇄됩니다:
  - 오류 (`ok=false`)
  - 느린 호출 (기본 임계값: `>= 50ms`)
  - 분석 오류
- **Verbose 모드 (`--verbose`)**: 모든 WS 요청/응답 트래픽을 인쇄합니다.

### WS 로그 스타일

`openclaw gateway` 는 Gateway당 스타일 스위치를 지원합니다:

- `--ws-log auto` (기본값): 정상 모드는 최적화됨; verbose 모드는 컴팩트 출력을 사용합니다.
- `--ws-log compact`: verbose 시 컴팩트 출력 (쌍 요청/응답)
- `--ws-log full`: verbose 시 전체 프레임당 출력
- `--compact`: `--ws-log compact` 의 별칭

예:

```bash
# 최적화됨 (오류/느림만)
openclaw gateway

# 모든 WS 트래픽 표시 (쌍)
openclaw gateway --verbose --ws-log compact

# 모든 WS 트래픽 표시 (메타 전체)
openclaw gateway --verbose --ws-log full
```

## 콘솔 형식화 (부문 로깅)

콘솔 포매터는 **TTY 인식** 이고 일관되고 접두사가 붙은 라인을 인쇄합니다.
부문 로거는 출력을 그룹화하고 스캔 가능하게 유지합니다.

동작:

- **부문 접두사** 모든 라인 (예: `[gateway]`, `[canvas]`, `[tailscale]`)
- **부문 색상** (부문당 안정적) 및 수준 색상화
- **출력이 TTY이거나 환경이 풍부한 터미널** (`TERM`/`COLORTERM`/`TERM_PROGRAM`) 처럼 보일 때 색상, `NO_COLOR` 존경
- **단축된 부문 접두사**: 선행 `gateway/` + `channels/` 을 삭제하고 마지막 2 개 세그먼트 유지 (예: `whatsapp/outbound`)
- **부문별 부로거** (자동 접두사 + 구조화된 필드 `{ subsystem }`)
- **`logRaw()`** QR/UX 출력용 (접두사 없음, 형식화 없음)
- **콘솔 스타일** (예: `pretty | compact | json`)
- **콘솔 로그 레벨** 파일 로그 레벨과 분리됨 (`logging.level` 을 `debug`/`trace` 로 설정할 때 파일이 전체 세부 유지)
- **WhatsApp 메시지 본문** `debug` 에서 기록됨 (verbose 모드에서 보려면 `--verbose` 사용)

이는 기존 파일 로그를 안정적으로 유지하면서 대화형 출력을 스캔 가능하게 만듭니다.
