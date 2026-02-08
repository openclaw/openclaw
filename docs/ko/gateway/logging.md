---
read_when:
    - 로깅 출력 또는 형식 변경
    - CLI 또는 게이트웨이 출력 디버깅
summary: 로깅 표면, 파일 로그, WS 로그 스타일 및 콘솔 형식
title: 벌채 반출
x-i18n:
    generated_at: "2026-02-08T16:04:41Z"
    model: gtx
    provider: google-translate
    source_hash: efb8eda5e77e3809369a8ff569fac110323a86b3945797093f20e9bc98f39b2e
    source_path: gateway/logging.md
    workflow: 15
---

# 벌채 반출

사용자에게 표시되는 개요(CLI + 제어 UI + 구성)는 다음을 참조하세요. [/벌채 반출](/logging).

OpenClaw에는 두 개의 로그 "표면"이 있습니다.

- **콘솔 출력** (터미널/디버그 UI에 표시되는 내용)
- **파일 로그** (JSON 라인) 게이트웨이 로거에 의해 작성되었습니다.

## 파일 기반 로거

- 기본 롤링 로그 파일은 다음 위치에 있습니다. `/tmp/openclaw/` (하루에 하나의 파일): `openclaw-YYYY-MM-DD.log`
  - 날짜는 게이트웨이 호스트의 현지 시간대를 사용합니다.
- 로그 파일 경로 및 수준은 다음을 통해 구성할 수 있습니다. `~/.openclaw/openclaw.json`:
  - `logging.file`
  - `logging.level`

파일 형식은 한 줄에 하나의 JSON 개체입니다.

Control UI Logs 탭은 게이트웨이(`logs.tail`).
CLI도 동일한 작업을 수행할 수 있습니다.

```bash
openclaw logs --follow
```

**상세 수준과 로그 수준**

- **파일 로그** 독점적으로 통제됩니다. `logging.level`.
- `--verbose` 영향을 미칠 뿐이다 **콘솔의 자세한 내용** (및 WS 로그 스타일) 그렇죠 **~ 아니다**
  파일 로그 수준을 높입니다.
- 파일 로그에서 자세한 정보만 캡처하려면 다음을 설정하십시오. `logging.level` 에게 `debug` 또는
  `trace`.

## 콘솔 캡처

CLI 캡처 `console.log/info/warn/error/debug/trace` 파일 로그에 기록합니다.
여전히 stdout/stderr로 인쇄하는 동안.

다음을 통해 콘솔의 자세한 정도를 독립적으로 조정할 수 있습니다.

- `logging.consoleLevel` (기본 `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## 도구 요약 수정

자세한 도구 요약(예: `🛠️ Exec: ...`) 민감한 토큰이 공격을 받기 전에 마스킹할 수 있습니다.
콘솔 스트림. 이것은 **도구 전용** 파일 로그를 변경하지 않습니다.

- `logging.redactSensitive`:`off` | `tools` (기본: `tools`)
- `logging.redactPatterns`: 정규식 문자열 배열(기본값 재정의)
  - 원시 정규식 문자열 사용(자동 `gi`), 또는 `/pattern/flags` 맞춤 플래그가 필요한 경우.
  - 일치 항목은 처음 6개 + 마지막 4개 문자(길이 >= 18)를 유지하여 마스크됩니다. 그렇지 않은 경우 `***`.
  - 기본값에는 공통 키 할당, CLI 플래그, JSON 필드, 전달자 헤더, PEM 블록 및 널리 사용되는 토큰 접두사가 포함됩니다.

## 게이트웨이 WebSocket 로그

게이트웨이는 두 가지 모드로 WebSocket 프로토콜 로그를 인쇄합니다.

- **일반 모드(아니요 `--verbose`)**: "흥미로운" RPC 결과만 인쇄됩니다.
  - 오류(`ok=false`)
  - 느린 호출(기본 임계값: `>= 50ms`)
  - 구문 분석 오류
- **상세 모드(`--verbose`)**: 모든 WS 요청/응답 트래픽을 인쇄합니다.

### WS 로그 스타일

`openclaw gateway` 게이트웨이별 스타일 스위치를 지원합니다.

- `--ws-log auto` (기본값): 일반 모드가 최적화됩니다. 자세한 모드는 압축 출력을 사용합니다.
- `--ws-log compact`: 장황한 경우 간단한 출력(요청/응답 쌍)
- `--ws-log full`: 장황한 경우 전체 프레임당 출력
- `--compact`: 별칭 `--ws-log compact`

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

콘솔 포맷터는 **TTY 인식** 일관되고 접두사가 붙은 줄을 인쇄합니다.
하위 시스템 로거는 출력을 그룹화하고 검색 가능한 상태로 유지합니다.

행동:

- **하위 시스템 접두사** 모든 줄에서(예: `[gateway]`, `[canvas]`, `[tailscale]`)
- **하위 시스템 색상** (하위 시스템별로 안정적) 및 레벨 색상 지정
- **출력이 TTY이거나 환경이 풍부한 터미널처럼 보일 때의 색상** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), 존경합니다 `NO_COLOR`
- **단축된 하위 시스템 접두사**: 앞선 방울 `gateway/` + `channels/`, 마지막 2개 세그먼트를 유지합니다(예: `whatsapp/outbound`)
- **하위 시스템별 하위 로거** (자동 접두어 + 구조화된 필드 `{ subsystem }`)
- **`logRaw()`** QR/UX 출력용(접두사 없음, 서식 없음)
- **콘솔 스타일** (예: `pretty | compact | json`)
- **콘솔 로그 수준** 파일 로그 수준과 별도로(파일은 다음과 같은 경우 전체 세부 정보를 유지합니다.) `logging.level` 로 설정되었습니다 `debug`/`trace`)
- **WhatsApp 메시지 본문** 에 기록되어 있습니다 `debug` (사용 `--verbose` 그들을 보기 위해)

이는 기존 파일 로그를 안정적으로 유지하는 동시에 대화형 출력을 검색 가능하게 만듭니다.
