---
summary: "로깅 표면, 파일 로그, WS 로그 스타일, 콘솔 포매팅"
read_when:
  - 로깅 출력 또는 형식을 변경할 때
  - CLI 또는 게이트웨이 출력을 디버깅할 때
title: "로깅"
---

# 로깅

사용자 관점의 개요 (CLI + Control UI + 설정)는 [/logging](/logging)을 참고하십시오.

OpenClaw 에는 두 가지 로그 '표면'이 있습니다:

- **콘솔 출력** (터미널 / Debug UI 에서 보이는 내용)
- **파일 로그** (JSON 라인 형식), 게이트웨이 로거가 기록

## 파일 기반 로거

- 기본 롤링 로그 파일은 `/tmp/openclaw/` 아래에 있습니다 (하루당 하나의 파일): `openclaw-YYYY-MM-DD.log`
  - 날짜는 게이트웨이 호스트의 로컬 타임존을 사용합니다.
- 로그 파일 경로와 레벨은 `~/.openclaw/openclaw.json` 를 통해 구성할 수 있습니다:
  - `logging.file`
  - `logging.level`

파일 형식은 한 줄당 하나의 JSON 객체입니다.

Control UI 의 Logs 탭은 게이트웨이를 통해 이 파일을 tail 합니다 (`logs.tail`).
CLI 도 동일하게 사용할 수 있습니다:

```bash
openclaw logs --follow
```

**Verbose 와 로그 레벨의 차이**

- **파일 로그**는 오직 `logging.level` 에 의해서만 제어됩니다.
- `--verbose` 는 **콘솔의 상세도** (및 WS 로그 스타일)에만 영향을 주며,
  파일 로그 레벨을 올리지는 않습니다.
- verbose 전용 세부 정보를 파일 로그에 남기려면 `logging.level` 을
  `debug` 또는 `trace` 로 설정하십시오.

## 콘솔 캡처

CLI 는 `console.log/info/warn/error/debug/trace` 을 캡처하여 파일 로그에 기록하면서,
stdout/stderr 로의 출력은 그대로 유지합니다.

콘솔 상세도는 다음을 통해 독립적으로 조정할 수 있습니다:

- `logging.consoleLevel` (기본값 `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## 도구 요약 마스킹

상세한 도구 요약 (예: `🛠️ Exec: ...`)은
콘솔 스트림에 도달하기 전에 민감한 토큰을 마스킹할 수 있습니다. 이는 **도구 전용**이며 파일 로그는 변경하지 않습니다.

- `logging.redactSensitive`: `off` | `tools` (기본값: `tools`)
- `logging.redactPatterns`: 정규식 문자열 배열 (기본값을 재정의)
  - 원시 정규식 문자열을 사용하십시오 (자동 `gi`), 또는 사용자 정의 플래그가 필요하면 `/pattern/flags` 을 사용하십시오.
  - 일치는 길이가 18 이상인 경우 처음 6자 + 마지막 4자를 유지하고, 그렇지 않으면 `***` 로 마스킹됩니다.
  - 기본값은 일반적인 키 할당, CLI 플래그, JSON 필드, bearer 헤더, PEM 블록, 널리 사용되는 토큰 접두사를 포함합니다.

## Gateway WebSocket 로그

게이트웨이는 WebSocket 프로토콜 로그를 두 가지 모드로 출력합니다:

- **일반 모드 (`--verbose` 없음)**: '중요한' RPC 결과만 출력합니다:
  - 오류 (`ok=false`)
  - 느린 호출 (기본 임계값: `>= 50ms`)
  - 파싱 오류
- **Verbose 모드 (`--verbose`)**: 모든 WS 요청/응답 트래픽을 출력합니다.

### WS 로그 스타일

`openclaw gateway` 는 게이트웨이별 스타일 전환을 지원합니다:

- `--ws-log auto` (기본값): 일반 모드는 최적화되며, verbose 모드에서는 간결한 출력 사용
- `--ws-log compact`: verbose 시 간결한 출력 (요청/응답 쌍)
- `--ws-log full`: verbose 시 프레임 단위 전체 출력
- `--compact`: `--ws-log compact` 의 별칭

예시:

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## 콘솔 포매팅 (서브시스템 로깅)

콘솔 포매터는 **TTY 인식**을 하며 일관된 접두사가 있는 줄을 출력합니다.
서브시스템 로거는 출력을 그룹화하여 훑어보기 쉽게 유지합니다.

동작 방식:

- 모든 줄에 **서브시스템 접두사** (예: `[gateway]`, `[canvas]`, `[tailscale]`)
- **서브시스템 색상** (서브시스템별로 고정) + 레벨 색상
- **출력이 TTY 이거나 환경이 풍부한 터미널로 보일 때 색상 사용** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), `NO_COLOR` 를 존중
- **축약된 서브시스템 접두사**: 선행 `gateway/` + `channels/` 을 제거하고 마지막 2개 세그먼트만 유지 (예: `whatsapp/outbound`)
- **서브시스템별 서브 로거** (자동 접두사 + 구조화 필드 `{ subsystem }`)
- QR/UX 출력을 위한 **`logRaw()`** (접두사 없음, 포매팅 없음)
- **콘솔 스타일** (예: `pretty | compact | json`)
- **콘솔 로그 레벨**은 파일 로그 레벨과 분리됨 (파일은 `logging.level` 가 `debug`/`trace` 로 설정된 경우 전체 세부 정보를 유지)
- **WhatsApp 메시지 본문**은 `debug` 레벨로 기록됩니다 (`--verbose` 을 사용하여 확인)

이를 통해 기존 파일 로그는 안정적으로 유지하면서, 상호작용형 출력은 훑어보기 쉽게 만듭니다.
