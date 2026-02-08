---
read_when:
    - 초보자에게 친숙한 로깅 개요가 필요합니다.
    - 로그 수준이나 형식을 구성하고 싶습니다.
    - 문제를 해결 중이며 로그를 빠르게 찾아야 하는 경우
summary: '로깅 개요: 파일 로그, 콘솔 출력, CLI 테일링 및 Control UI'
title: 벌채 반출
x-i18n:
    generated_at: "2026-02-08T16:03:27Z"
    model: gtx
    provider: google-translate
    source_hash: 884fcf4a906adff34d546908e22abd283cb89fe0845076cf925c72384ec3556b
    source_path: logging.md
    workflow: 15
---

# 벌채 반출

OpenClaw는 두 위치에 로그인합니다.

- **파일 로그** (JSON 라인)은 게이트웨이에서 작성되었습니다.
- **콘솔 출력** 터미널과 Control UI에 표시됩니다.

이 페이지에서는 로그가 있는 위치, 로그를 읽는 방법, 로그를 구성하는 방법을 설명합니다.
레벨과 형식.

## 로그가 있는 곳

기본적으로 게이트웨이는 다음 위치에 롤링 로그 파일을 작성합니다.

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

날짜는 게이트웨이 호스트의 현지 시간대를 사용합니다.

이것을 재정의할 수 있습니다. `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## 로그를 읽는 방법

### CLI: 라이브 테일(권장)

CLI를 사용하여 RPC를 통해 게이트웨이 로그 파일을 추적합니다.

```bash
openclaw logs --follow
```

출력 모드:

- **TTY 세션**: 예쁘고 색상이 지정되었으며 구조화된 로그 라인입니다.
- **비TTY 세션**: 일반 텍스트.
- `--json`: 줄로 구분된 JSON(줄당 하나의 로그 이벤트).
- `--plain`: TTY 세션에서 일반 텍스트를 강제합니다.
- `--no-color`: ANSI 색상을 비활성화합니다.

JSON 모드에서 CLI는 다음을 내보냅니다. `type`-태그가 붙은 개체:

- `meta`: 스트림 메타데이터(파일, 커서, 크기)
- `log`: 구문 분석된 로그 항목
- `notice`: 잘림/회전 힌트
- `raw`: 구문 분석되지 않은 로그 줄

게이트웨이에 연결할 수 없는 경우 CLI는 실행할 짧은 힌트를 인쇄합니다.

```bash
openclaw doctor
```

### 컨트롤 UI(웹)

컨트롤 UI **로그** 탭은 다음을 사용하여 동일한 파일을 종료합니다. `logs.tail`.
보다 [/웹/컨트롤-UI](/web/control-ui) 여는 방법에 대해.

### 채널 전용 로그

채널 활동(WhatsApp/Telegram 등)을 필터링하려면 다음을 사용하세요.

```bash
openclaw channels logs --channel whatsapp
```

## 로그 형식

### 파일 로그(JSONL)

로그 파일의 각 줄은 JSON 개체입니다. CLI 및 제어 UI는 이를 구문 분석합니다.
구조화된 출력을 렌더링하기 위한 항목(시간, 레벨, 하위 시스템, 메시지)

### 콘솔 출력

콘솔 로그는 **TTY 인식** 가독성을 위해 형식이 지정되었습니다.

- 하위 시스템 접두사(예: `gateway/channels/whatsapp`)
- 레벨 색상 지정(정보/경고/오류)
- 선택적 컴팩트 또는 JSON 모드

콘솔 포맷은 다음에 의해 제어됩니다. `logging.consoleStyle`.

## 로깅 구성

모든 로깅 구성은 `logging` ~에 `~/.openclaw/openclaw.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### 로그 수준

- `logging.level`:**파일 로그** (JSONL) 수준입니다.
- `logging.consoleLevel`:**콘솔** 장황한 수준.

`--verbose` 콘솔 출력에만 영향을 미칩니다. 파일 로그 수준은 변경되지 않습니다.

### 콘솔 스타일

`logging.consoleStyle`:

- `pretty`: 인간 친화적이고 색상이 있으며 타임스탬프가 있습니다.
- `compact`: 더 타이트한 출력(장시간 세션에 가장 적합)
- `json`: 행당 JSON(로그 프로세서의 경우).

### 편집

도구 요약은 콘솔에 도달하기 전에 민감한 토큰을 수정할 수 있습니다.

- `logging.redactSensitive`:`off` | `tools` (기본: `tools`)
- `logging.redactPatterns`: 기본 세트를 재정의할 정규식 문자열 목록

편집이 영향을 미침 **콘솔 출력만** 파일 로그를 변경하지 않습니다.

## 진단 + OpenTelemetry

진단은 모델 실행을 위한 구조화된 기계 판독 가능 이벤트입니다. **그리고**
메시지 흐름 원격 분석(웹후크, 대기열, 세션 상태). 그들은 그렇습니다 **~ 아니다**
로그 교체; 메트릭, 추적 및 기타 내보내기를 제공하기 위해 존재합니다.

진단 이벤트는 프로세스 중에 내보내지지만 내보내기는 다음 경우에만 연결됩니다.
진단 + 내보내기 플러그인이 활성화되었습니다.

### OpenTelemetry와 OTLP

- **오픈텔레메트리(OTel)**: 데이터 모델 + 추적, 측정항목, 로그용 SDK.
- **OTLP**: Otel 데이터를 수집기/백엔드로 내보내는 데 사용되는 유선 프로토콜입니다.
- OpenClaw는 다음을 통해 수출합니다. **OTLP/HTTP(프로토버프)** 오늘.

### 내보낸 신호

- **측정항목**: 카운터 + 히스토그램(토큰 사용량, 메시지 흐름, 대기열).
- **흔적**: 모델 사용 + 웹훅/메시지 처리 범위입니다.
- **로그**: 다음과 같은 경우 OTLP를 통해 내보냅니다. `diagnostics.otel.logs` 활성화되었습니다. 로그
  볼륨이 높을 수 있습니다. 유지하다 `logging.level` 그리고 수출업자 필터를 염두에 두세요.

### 진단 이벤트 카탈로그

모델 사용법:

- `model.usage`: 토큰, 비용, 기간, 컨텍스트, 공급자/모델/채널, 세션 ID.

메시지 흐름:

- `webhook.received`: 채널당 웹훅 수신.
- `webhook.processed`: 처리된 웹훅 + 기간.
- `webhook.error`: 웹훅 핸들러 오류입니다.
- `message.queued`: 메시지가 처리를 위해 대기열에 추가되었습니다.
- `message.processed`: 결과 + 기간 + 선택적 오류.

대기열 + 세션:

- `queue.lane.enqueue`: 명령 대기열 레인 대기열 + 깊이.
- `queue.lane.dequeue`: 명령 대기열 레인 대기열 해제 + 대기 시간.
- `session.state`: 세션 상태 전환 + 이유.
- `session.stuck`: 세션 중단 경고 + 수명.
- `run.attempt`: 재시도/시도 메타데이터를 실행합니다.
- `diagnostic.heartbeat`: 집계 카운터(웹후크/큐/세션).

### 진단 활성화(내보내기 없음)

플러그인이나 맞춤 싱크에 진단 이벤트를 사용하려면 다음을 사용하세요.

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 진단 플래그(대상 로그)

플래그를 사용하여 로그를 발생시키지 않고 추가 대상 디버그 로그를 활성화합니다. `logging.level`.
플래그는 대소문자를 구분하며 와일드카드를 지원합니다(예: `telegram.*` 또는 `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

환경 재정의(일회성):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

참고:

- 플래그 로그는 표준 로그 파일로 이동합니다( `logging.file`).
- 출력은 여전히 ​​다음에 따라 수정됩니다. `logging.redactSensitive`.
- 전체 가이드: [/진단/플래그](/diagnostics/flags).

### OpenTelemetry로 내보내기

진단은 다음을 통해 내보낼 수 있습니다. `diagnostics-otel` 플러그인(OTLP/HTTP). 이
OTLP/HTTP를 허용하는 모든 OpenTelemetry 수집기/백엔드에서 작동합니다.

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

참고:

- 다음을 사용하여 플러그인을 활성화할 수도 있습니다. `openclaw plugins enable diagnostics-otel`.
- `protocol` 현재 지원 `http/protobuf` 오직. `grpc` 무시됩니다.
- 측정항목에는 토큰 사용량, 비용, 컨텍스트 크기, 실행 기간 및 메시지 흐름이 포함됩니다.
  카운터/히스토그램(웹후크, 대기열, 세션 상태, 대기열 깊이/대기)
- 추적/측정항목은 다음으로 전환할 수 있습니다. `traces` / `metrics` (기본값: 켜짐). 흔적
  활성화된 경우 모델 사용 범위와 웹훅/메시지 처리 범위를 포함합니다.
- 세트 `headers` 수집기가 인증을 요구할 때.
- 지원되는 환경 변수: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`,`OTEL_EXPORTER_OTLP_PROTOCOL`.

### 내보낸 측정항목(이름 + 유형)

모델 사용법:

- `openclaw.tokens` (카운터, 속성: `openclaw.token`,`openclaw.channel`,
  `openclaw.provider`,`openclaw.model`)
- `openclaw.cost.usd` (카운터, 속성: `openclaw.channel`,`openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (히스토그램, 속성: `openclaw.channel`,
  `openclaw.provider`,`openclaw.model`)
- `openclaw.context.tokens` (히스토그램, 속성: `openclaw.context`,
  `openclaw.channel`,`openclaw.provider`,`openclaw.model`)

메시지 흐름:

- `openclaw.webhook.received` (카운터, 속성: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (카운터, 속성: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (히스토그램, 속성: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (카운터, 속성: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (카운터, 속성: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (히스토그램, 속성: `openclaw.channel`,
  `openclaw.outcome`)

대기열 + 세션:

- `openclaw.queue.lane.enqueue` (카운터, 속성: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (카운터, 속성: `openclaw.lane`)
- `openclaw.queue.depth` (히스토그램, 속성: `openclaw.lane` 또는 
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (히스토그램, 속성: `openclaw.lane`)
- `openclaw.session.state` (카운터, 속성: `openclaw.state`,`openclaw.reason`)
- `openclaw.session.stuck` (카운터, 속성: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (히스토그램, 속성: `openclaw.state`)
- `openclaw.run.attempt` (카운터, 속성: `openclaw.attempt`)

### 내보낸 범위(이름 + 키 속성)

- `openclaw.model.usage`
  - `openclaw.channel`,`openclaw.provider`,`openclaw.model`
  - `openclaw.sessionKey`,`openclaw.sessionId`
  - `openclaw.tokens.*` (입력/출력/cache_read/cache_write/전체)
- `openclaw.webhook.processed`
  - `openclaw.channel`,`openclaw.webhook`,`openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`,`openclaw.webhook`,`openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`,`openclaw.outcome`,`openclaw.chatId`,
    `openclaw.messageId`,`openclaw.sessionKey`,`openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`,`openclaw.ageMs`,`openclaw.queueDepth`,
    `openclaw.sessionKey`,`openclaw.sessionId`

### 샘플링 + 플러싱

- 추적 샘플링: `diagnostics.otel.sampleRate` (0.0-1.0, 루트 범위만 해당)
- 측정항목 내보내기 간격: `diagnostics.otel.flushIntervalMs` (최소 1000ms).

### 프로토콜 참고사항

- OTLP/HTTP 엔드포인트는 다음을 통해 설정할 수 있습니다. `diagnostics.otel.endpoint` 또는 
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- 엔드포인트에 이미 다음이 포함되어 있는 경우 `/v1/traces` 또는 `/v1/metrics`, 그대로 사용됩니다.
- 엔드포인트에 이미 다음이 포함되어 있는 경우 `/v1/logs`, 로그에 그대로 사용됩니다.
- `diagnostics.otel.logs` 기본 로거 출력에 대한 OTLP 로그 내보내기를 활성화합니다.

### 로그 내보내기 동작

- OTLP 로그는 다음에 기록된 것과 동일한 구조화된 레코드를 사용합니다. `logging.file`.
- 존경 `logging.level` (파일 로그 수준). 콘솔 편집은 **~ 아니다** 적용하다
  OTLP 로그에.
- 대용량 설치에서는 OTLP 수집기 샘플링/필터링을 선호해야 합니다.

## 문제 해결 팁

- **게이트웨이에 연결할 수 없나요?** 달리다 `openclaw doctor` 첫 번째.
- **로그가 비어 있나요?** 게이트웨이가 실행 중이고 파일 경로에 쓰고 있는지 확인하세요.
  안으로 `logging.file`.
- **더 자세한 내용이 필요하신가요?**세트 `logging.level` 에게 `debug` 또는 `trace` 그리고 다시 시도하세요.
