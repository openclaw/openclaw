---
summary: "로깅 개요: 파일 로그, 콘솔 출력, CLI 테일링 및 제어 UI"
read_when:
  - 로깅에 대한 초보 친화적인 개요가 필요할 때
  - 로그 레벨이나 포맷을 설정하고 싶을 때
  - 문제를 해결하고 신속하게 로그를 찾아야 할 때
title: "로깅"
---

# 로깅

OpenClaw는 두 장소에 로그를 남깁니다:

- **파일 로그** (JSON 라인) 게이트웨이에서 작성.
- **콘솔 출력**은 터미널과 제어 UI에 표시됩니다.

이 페이지에서는 로그의 저장 위치, 로그를 읽는 방법, 로그 레벨 및 포맷을 설정하는 방법을 설명합니다.

## 로그 저장 위치

기본적으로 게이트웨이는 다음 위치에 순환 로그 파일을 작성합니다:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

날짜는 게이트웨이 호스트의 로컬 표준시를 사용합니다.

이를 다음과 같이 변경할 수 있습니다: `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## 로그 읽는 방법

### CLI: 실시간 테일링 (권장)

CLI를 사용하여 RPC를 통해 게이트웨이 로그 파일을 테일링하십시오:

```bash
openclaw logs --follow
```

출력 모드:

- **TTY 세션**: 보기 좋은 컬러, 구조화된 로그 라인.
- **비-TTY 세션**: 일반 텍스트.
- `--json`: 줄로 구분된 JSON (한 줄당 하나의 로그 이벤트).
- `--plain`: TTY 세션에서 일반 텍스트 강제 적용.
- `--no-color`: ANSI 색상 비활성화.

JSON 모드에서는, CLI가 `type` 태그가 있는 객체를 내보냅니다:

- `meta`: 스트림 메타데이터 (파일, 커서, 크기)
- `log`: 해석된 로그 항목
- `notice`: 자르기/회전 힌트
- `raw`: 해석되지 않은 로그 줄

게이트웨이에 접근할 수 없으면, CLI는 다음을 실행하라는 짧은 힌트를 출력합니다:

```bash
openclaw doctor
```

### 제어 UI (웹)

제어 UI의 **로그** 탭은 `logs.tail`을 사용하여 동일한 파일을 테일링합니다.
열기 방법은 [/web/control-ui](/web/control-ui)에서 확인할 수 있습니다.

### 채널 전용 로그

채널 활동(WhatsApp/Telegram 등)을 필터링하려면 다음을 사용하십시오:

```bash
openclaw channels logs --channel whatsapp
```

## 로그 포맷

### 파일 로그 (JSONL)

로그 파일의 각 줄은 JSON 객체입니다. CLI 및 제어 UI는 이러한 항목을 파싱하여 구조화된 출력(시간, 레벨, 서브시스템, 메시지)을 렌더링합니다.

### 콘솔 출력

콘솔 로그는 **TTY 인식**을 하며 읽기 쉽게 포맷되어 있습니다:

- 서브시스템 접두사 (예: `gateway/channels/whatsapp`)
- 레벨 색상 (info/warn/error)
- 선택적 compact 또는 JSON 모드

콘솔 포맷은 `logging.consoleStyle`에 의해 제어됩니다.

## 로깅 설정

모든 로깅 설정은 `~/.openclaw/openclaw.json`의 `logging` 아래에 있습니다.

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

### 로그 레벨

- `logging.level`: **파일 로그** (JSONL) 레벨.
- `logging.consoleLevel`: **콘솔**의 상세도 레벨.

`--verbose`는 콘솔 출력에만 영향을 주며, 파일 로그 레벨은 변경하지 않습니다.

### 콘솔 스타일

`logging.consoleStyle`:

- `pretty`: 사람이 읽기 쉬운 컬러 및 타임스탬프 포함.
- `compact`: 긴 세션에 적합한 간결한 출력.
- `json`: 로그 처리기 용도로 줄 당 JSON.

### 편집

도구 요약은 콘솔에 도달하기 전에 민감한 토큰을 편집할 수 있습니다:

- `logging.redactSensitive`: `off` | `tools` (기본값: `tools`)
- `logging.redactPatterns`: 기본 집합을 재정의하기 위한 정규식 문자열 목록

편집은 **콘솔 출력에만** 영향을 미치며 파일 로그는 변경하지 않습니다.

## 진단 + OpenTelemetry

진단은 모델 실행 및 메시지 흐름 텔레메트리 (웹훅, 대기열, 세션 상태)에 대한 구조화된 기계 판독 가능 이벤트입니다. 로그를 대체하지 않으며, 메트릭, 트레이스 및 기타 출력에 대한 피드 역할을 합니다.

진단 이벤트는 프로세스 내에서 발생하지만, 진단 및 출력 플러그인이 활성화되었을 경우에만 출력기가 연결됩니다.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: 트레이스, 메트릭 및 로그에 대한 데이터 모델 + SDK.
- **OTLP**: OTel 데이터를 수집기/백엔드로 내보내기 위한 와이어 프로토콜.
- OpenClaw는 현재 **OTLP/HTTP (protobuf)**를 통해 내보냅니다.

### 내보내는 신호

- **메트릭**: 카운터 + 히스토그램 (토큰 사용량, 메시지 흐름, 대기열).
- **트레이스**: 모델 사용 + 웹훅/메시지 처리에 대한 스팬.
- **로그**: `diagnostics.otel.logs`가 활성화된 경우 OTLP를 통해 내보냅니다. 로그 볼륨이 높을 수 있으므로 `logging.level` 및 출력 필터를 염두에 두십시오.

### 진단 이벤트 카탈로그

모델 사용:

- `model.usage`: 토큰, 비용, 기간, 컨텍스트, 프로바이더/모델/채널, 세션 IDs.

메시지 흐름:

- `webhook.received`: 채널 당 웹훅 인그레스.
- `webhook.processed`: 웹훅 처리 완료 + 기간.
- `webhook.error`: 웹훅 처리기 오류.
- `message.queued`: 처리 대기열에 추가된 메시지.
- `message.processed`: 결과 + 기간 + 선택적 오류.

대기열 + 세션:

- `queue.lane.enqueue`: 명령 대기열 항목 추가 + 깊이.
- `queue.lane.dequeue`: 명령 대기열 항목 제거 + 대기 시간.
- `session.state`: 세션 상태 전환 + 이유.
- `session.stuck`: 세션 정체 경고 + 연령.
- `run.attempt`: 실행 재시도/시도 메타데이터.
- `diagnostic.heartbeat`: 집계 카운터 (웹훅/대기열/세션).

### 진단 활성화 (출력기 없음)

플러그인 또는 사용자 정의 싱크에 진단 이벤트를 사용할 수 있도록 하려면:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 진단 플래그 (목표 로그)

`logging.level`을 높이지 않고도 추가 타겟 디버그 로그를 활성화하기 위해 플래그를 사용하십시오.
플래그는 대소문자를 구분하지 않으며 와일드카드를 지원합니다 (예: `telegram.*` 또는 `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

환경 변수 오버라이드 (일회성):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

주의사항:

- 플래그 로그는 표준 로그 파일로 이동합니다 (`logging.file`과 동일).
- 출력은 여전히 `logging.redactSensitive`에 따라 편집됩니다.
- 전체 가이드: [/diagnostics/flags](/diagnostics/flags).

### OpenTelemetry로 내보내기

`diagnostics-otel` 플러그인 (OTLP/HTTP)을 통해 진단을 내보낼 수 있습니다. OTLP/HTTP를 수용할 수 있는 모든 OpenTelemetry 수집기/백엔드와 작동합니다.

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

주의사항:

- `openclaw plugins enable diagnostics-otel`을 사용하여 플러그인을 활성화할 수 있습니다.
- `protocol`은 현재 `http/protobuf`만 지원합니다. `grpc`는 무시됩니다.
- 메트릭에는 토큰 사용량, 비용, 컨텍스트 크기, 실행 시간 및 메시지 흐름 카운터/히스토그램 (웹훅, 대기열, 세션 상태, 대기열 깊이/대기)이 포함됩니다.
- `traces` / `metrics` (기본값: 켜짐)으로 트레이스/메트릭을 토글할 수 있습니다. 트레이스에는 모델 사용 스팬과 웹훅/메시지 처리 스팬이 포함됩니다.
- 수집기에 인증이 필요한 경우 `headers`를 설정하십시오.
- 지원되는 환경 변수: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### 내보내는 메트릭 (이름 + 유형)

모델 사용:

- `openclaw.tokens` (카운터, 속성: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (카운터, 속성: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (히스토그램, 속성: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (히스토그램, 속성: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

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

큐 + 세션:

- `openclaw.queue.lane.enqueue` (카운터, 속성: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (카운터, 속성: `openclaw.lane`)
- `openclaw.queue.depth` (히스토그램, 속성: `openclaw.lane` 또는
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (히스토그램, 속성: `openclaw.lane`)
- `openclaw.session.state` (카운터, 속성: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (카운터, 속성: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (히스토그램, 속성: `openclaw.state`)
- `openclaw.run.attempt` (카운터, 속성: `openclaw.attempt`)

### 내보내는 스팬 (이름 + 주요 속성)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### 샘플링 + 플러싱

- 트레이스 샘플링: `diagnostics.otel.sampleRate` (0.0–1.0, 루트 스팬만).
- 메트릭 내보내기 간격: `diagnostics.otel.flushIntervalMs` (최소 1000ms).

### 프로토콜 주의사항

- OTLP/HTTP 엔드포인트는 `diagnostics.otel.endpoint` 또는
  `OTEL_EXPORTER_OTLP_ENDPOINT`를 통해 설정할 수 있습니다.
- 엔드포인트가 이미 `/v1/traces` 또는 `/v1/metrics`를 포함한 경우 그대로 사용됩니다.
- 엔드포인트가 이미 `/v1/logs`를 포함한 경우 로그에 그대로 사용됩니다.
- `diagnostics.otel.logs`는 주 로그 출력에 대한 OTLP 로그 내보내기를 활성화합니다.

### 로그 내보내기 동작

- OTLP 로그는 `logging.file`에 기록된 동일한 구조화된 레코드를 사용합니다.
- `logging.level` (파일 로그 레벨)를 따릅니다. 콘솔 편집은 OTLP 로그에 **적용되지 않습니다**.
- 고용량 설치는 OTLP 수집기 샘플링/필터링을 선호해야 합니다.

## 문제 해결 팁

- **게이트웨이에 접근할 수 없습니까?** 먼저 `openclaw doctor`를 실행하세요.
- **로그가 비어 있나요?** 게이트웨이가 실행 중이며 `logging.file`의 파일 경로에 기록하고 있는지 확인하세요.
- **더 많은 세부 정보가 필요합니까?** `logging.level`을 `debug` 또는 `trace`로 설정하고 다시 시도하세요.
