---
summary: "로깅 개요: 파일 로그, 콘솔 출력, CLI 추적 및 Control UI"
read_when:
  - 로깅의 초보자 친화적 개요가 필요할 때
  - 로그 레벨 또는 형식을 구성하려고 할 때
  - 문제 해결 중이고 로그를 빠르게 찾아야 할 때
title: "로깅"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: logging.md
  workflow: 15
---

# 로깅

OpenClaw 는 두 곳에서 로깅합니다:

- **파일 로그** (JSON 라인) Gateway 에서 작성함.
- **콘솔 출력** 터미널 및 Control UI 에 표시됨.

이 페이지는 로그가 어디에 있는지, 읽는 방법, 로그 레벨 및 형식을 구성하는 방법을 설명합니다.

## 로그가 어디에 있습니까

기본적으로 Gateway 는 다음 아래에 롤링 로그 파일을 작성합니다:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

날짜는 Gateway 호스트의 로컬 시간대를 사용합니다.

`~/.openclaw/openclaw.json` 에서 재정의할 수 있습니다:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## 로그를 읽는 방법

### CLI: 실시간 추적 (권장)

CLI 를 사용하여 RPC 를 통해 Gateway 로그 파일을 추적합니다:

```bash
openclaw logs --follow
```

출력 모드:

- **TTY 세션**: 예쁜, 색상화된, 구조화된 로그 라인.
- **non-TTY 세션**: 일반 텍스트.
- `--json`: 행 구분 JSON (행당 하나의 로그 이벤트).
- `--plain`: TTY 세션에서 일반 텍스트 강제.
- `--no-color`: ANSI 색상 비활성화.

JSON 모드에서 CLI 는 `type` 태그 객체를 발생시킵니다:

- `meta`: 스트림 메타데이터 (파일, 커서, 크기)
- `log`: 분석된 로그 항목
- `notice`: 잘림/회전 힌트
- `raw`: 분석되지 않은 로그 라인

Gateway 도달 불가능하면 CLI 는 다음을 실행하도록 짧은 힌트를 인쇄합니다:

```bash
openclaw doctor
```

### Control UI (웹)

Control UI 의 **Logs** 탭은 `logs.tail` 을 사용하여 동일한 파일을 추적합니다.
[/web/control-ui](/web/control-ui) 를 열면 참조하세요.

### 채널 전용 로그

WhatsApp/Telegram/etc 채널 활동을 필터링하려면:

```bash
openclaw channels logs --channel whatsapp
```

## 로그 형식

### 파일 로그 (JSONL)

로그 파일의 각 라인은 JSON 객체입니다. CLI 및 Control UI 는 이러한 항목을 분석하여 구조화된 출력 (시간, 레벨, 부문, 메시지) 을 렌더링합니다.

### 콘솔 출력

콘솔 로그는 **TTY 인식** 이고 읽기 쉽도록 형식화됩니다:

- 부문 접두사 (예: `gateway/channels/whatsapp`)
- 레벨 색상화 (info/warn/error)
- 선택적 컴팩트 또는 JSON 모드

콘솔 형식화는 `logging.consoleStyle` 로 제어됩니다.

## 로깅 구성

모든 로깅 구성은 `~/.openclaw/openclaw.json` 의 `logging` 아래에 있습니다.

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
- `logging.consoleLevel`: **콘솔** 일반성 레벨.

**`OPENCLAW_LOG_LEVEL`** 환경 변수 (예: `OPENCLAW_LOG_LEVEL=debug`) 를 통해 둘 다 오버라이드할 수 있습니다. 환경 변수는 구성 파일보다 우선하므로 `openclaw.json` 을 편집하지 않고도 단일 실행에 대해 일반성을 올릴 수 있습니다. 또한 전역 CLI 옵션 **`--log-level <level>`** (예: `openclaw --log-level debug gateway run`) 를 전달할 수 있습니다. 이 명령의 환경 변수를 오버라이드합니다.

`--verbose` 는 콘솔 출력에만 영향을 미치며 파일 로그 레벨을 변경하지 않습니다.

### 콘솔 스타일

`logging.consoleStyle`:

- `pretty`: 인간 친화적, 색상, 타임스탬프 포함.
- `compact`: 더 조밀한 출력 (긴 세션에 최적).
- `json`: JSON 행 (로그 프로세서용).

### 편집

도구 요약은 콘솔에 도달하기 전에 민감한 토큰을 편집할 수 있습니다:

- `logging.redactSensitive`: `off` | `tools` (기본값: `tools`)
- `logging.redactPatterns`: 기본 세트를 오버라이드하는 정규 표현식 문자열 목록

편집은 **콘솔 출력만** 영향을 미치고 파일 로그를 변경하지 않습니다.

## 진단 + OpenTelemetry

진단은 모델 실행 **및** 메시지 흐름 원격 측정 (웹훅, 큐잉, 세션 상태) 에 대한 구조화된, 머신 읽을 수 있는 이벤트입니다. 로그를 대체하지 않습니다; 메트릭, 추적 및 기타 수출자에게 공급하기 위해 존재합니다.

진단 이벤트는 진행 중에 발생하지만 진단 + 수출자 플러그인이 활성화되면 수출자만 연결합니다.

### OpenTelemetry 대 OTLP

- **OpenTelemetry (OTel)**: 추적, 메트릭 및 로그용 데이터 모델 + SDK.
- **OTLP**: OTel 데이터를 수집기/백엔드로 내보내는 데 사용되는 와이어 프로토콜.
- OpenClaw 는 현재 **OTLP/HTTP (protobuf)** 를 통해 수출합니다.

### 신호 내보냄

- **메트릭**: 카운터 + 히스토그램 (토큰 사용, 메시지 흐름, 큐잉).
- **추적**: 모델 사용 + 웹훅/메시지 처리용 스팬.
- **로그**: `diagnostics.otel.logs` 가 활성화되면 OTLP 를 통해 내보냄. 로그 볼륨이 높을 수 있습니다; `logging.level` 및 수출자 필터를 염두에 두세요.

### 진단 이벤트 카탈로그

모델 사용:

- `model.usage`: 토큰, 비용, 기간, 컨텍스트, 공급자/모델/채널, 세션 ID.

메시지 흐름:

- `webhook.received`: 채널당 웹훅 유입.
- `webhook.processed`: 웹훅 처리 + 기간.
- `webhook.error`: 웹훅 핸들러 오류.
- `message.queued`: 처리를 위해 메시지가 큐에 나열됨.
- `message.processed`: 결과 + 기간 + 선택적 오류.

큐 + 세션:

- `queue.lane.enqueue`: 명령 큐 차선 큐 + 깊이.
- `queue.lane.dequeue`: 명령 큐 차선 큐 해제 + 대기 시간.
- `session.state`: 세션 상태 전환 + 이유.
- `session.stuck`: 세션 고착 경고 + 나이.
- `run.attempt`: 실행 재시도/시도 메타데이터.
- `diagnostic.heartbeat`: 집계 카운터 (웹훅/큐/세션).

### 진단 활성화 (수출자 없음)

진단 이벤트를 플러그인 또는 사용자 정의 싱크에 사용 가능하게 하려면 이를 사용합니다:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 진단 플래그 (대상 로그)

플래그를 사용하여 `logging.level` 올리지 않고 추가 대상 디버그 로그를 켭니다.
플래그는 대소문자 구분 안 하며 와일드카드를 지원합니다 (예: `telegram.*` 또는 `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

환경 오버라이드 (일회성):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

참고:

- 플래그 로그는 표준 로그 파일로 이동 (예: `logging.file`).
- 출력은 `logging.redactSensitive` 에 따라 편집됩니다.
- 전체 가이드: [/diagnostics/flags](/diagnostics/flags).

### OpenTelemetry 로 내보내기

진단은 `diagnostics-otel` 플러그인 (OTLP/HTTP) 을 통해 내보낼 수 있습니다. 이는 OTLP/HTTP 를 수락하는 모든 OpenTelemetry 수집기/백엔드와 함께 작동합니다.

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

- 플러그인을 `openclaw plugins enable diagnostics-otel` 로도 활성화할 수 있습니다.
- `protocol` 현재는 `http/protobuf` 만 지원합니다. `grpc` 무시됨.
- 메트릭은 토큰 사용, 비용, 컨텍스트 크기, 실행 기간 및 메시지 흐름 카운터/히스토그램 (웹훅, 큐잉, 세션 상태, 큐 깊이/대기) 를 포함합니다.
- 추적/메트릭은 `traces` / `metrics` (기본값: on) 로 전환할 수 있습니다. 추적은 활성화될 때 모델 사용 스팬 + 웹훅/메시지 처리 스팬을 포함합니다.
- 수집기에서 인증이 필요할 때 `headers` 설정합니다.
- 환경 변수 지원됨: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### 내보낸 메트릭 (이름 + 유형)

모델 사용:

- `openclaw.tokens` (카운터, attr: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (카운터, attr: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (히스토그램, attr: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (히스토그램, attr: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

메시지 흐름:

- `openclaw.webhook.received` (카운터, attr: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (카운터, attr: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (히스토그램, attr: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (카운터, attr: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (카운터, attr: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (히스토그램, attr: `openclaw.channel`,
  `openclaw.outcome`)

큐 + 세션:

- `openclaw.queue.lane.enqueue` (카운터, attr: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (카운터, attr: `openclaw.lane`)
- `openclaw.queue.depth` (히스토그램, attr: `openclaw.lane` 또는
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (히스토그램, attr: `openclaw.lane`)
- `openclaw.session.state` (카운터, attr: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (카운터, attr: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (히스토그램, attr: `openclaw.state`)
- `openclaw.run.attempt` (카운터, attr: `openclaw.attempt`)

### 내보낸 스팬 (이름 + 주요 attr)

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

- 추적 샘플링: `diagnostics.otel.sampleRate` (0.0 - 1.0, root 스팬만).
- 메트릭 내보내기 간격: `diagnostics.otel.flushIntervalMs` (최소 1000 밀리초).

### 프로토콜 참고

- OTLP/HTTP 끝점은 `diagnostics.otel.endpoint` 또는
  `OTEL_EXPORTER_OTLP_ENDPOINT` 로 설정할 수 있습니다.
- 끝점이 이미 `/v1/traces` 또는 `/v1/metrics` 를 포함하면 있는 그대로 사용됩니다.
- 끝점이 이미 `/v1/logs` 를 포함하면 로그에 대해 있는 그대로 사용됩니다.
- `diagnostics.otel.logs` 주 로거 출력의 OTLP 로그 내보내기를 활성화합니다.

### 로그 내보내기 동작

- OTLP 로그는 `logging.file` 로 작성된 동일한 구조화된 레코드를 사용합니다.
- `logging.level` (파일 로그 레벨) 을 존경합니다. 콘솔 편집은 **OTLP 로그에 적용되지 않습니다**.
- 대량 설치는 OTLP 수집기 샘플링/필터링을 선호해야 합니다.

## 문제 해결 팁

- **Gateway 도달 불가능?** 먼저 `openclaw doctor` 실행합니다.
- **로그 비어 있음?** Gateway 가 실행 중이고 `logging.file` 의 파일 경로에 작성 중인지 확인합니다.
- **더 자세히 필요?** `logging.level` 을 `debug` 또는 `trace` 로 설정하고 다시 시도합니다.
