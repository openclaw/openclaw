---
summary: "Debugging tools: watch mode, raw model streams, and tracing reasoning leakage"
read_when:
  - You need to inspect raw model output for reasoning leakage
  - You want to run the Gateway in watch mode while iterating
  - You need a repeatable debugging workflow
title: "Debugging"
x-i18n:
  source_hash: 504c824bff4790006c8b73600daca66b919e049178e9711e6e65b6254731911a
---

# 디버깅

이 페이지에서는 특히 스트리밍 출력을 위한 디버깅 도우미에 대해 설명합니다.
공급자는 추론을 일반 텍스트에 혼합합니다.

## 런타임 디버그 재정의

채팅에서 `/debug`를 사용하여 **런타임 전용** 구성 재정의(디스크가 아닌 메모리)를 설정하세요.
`/debug`는 기본적으로 비활성화되어 있습니다. `commands.debug: true`로 활성화하세요.
`openclaw.json`를 편집하지 않고 모호한 설정을 전환해야 할 때 유용합니다.

예:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` 모든 재정의를 지우고 온디스크 구성으로 돌아갑니다.

## 게이트웨이 감시 모드

빠른 반복을 위해 파일 감시자 아래에서 게이트웨이를 실행합니다.

```bash
pnpm gateway:watch --force
```

이는 다음에 매핑됩니다.

```bash
tsx watch src/entry.ts gateway --force
```

`gateway:watch` 뒤에 게이트웨이 CLI 플래그를 추가하면 통과됩니다.
다시 시작할 때마다.

## 개발자 프로필 + 개발자 게이트웨이(--dev)

개발 프로필을 사용하여 상태를 분리하고 안전하고 일회용 설정을 시작하세요.
디버깅. **두 가지** `--dev` 플래그가 있습니다.

- **전역 `--dev` (프로필):** `~/.openclaw-dev` 아래 상태를 격리하고
  기본적으로 게이트웨이 포트는 `19001`입니다(파생 포트도 이에 따라 이동됩니다).
- **`gateway --dev`: 게이트웨이에 기본 구성을 자동 생성하도록 지시합니다. +
  작업 공간** 누락된 경우(BOOTSTRAP.md 건너뛰기)

권장 흐름(개발자 프로필 + 개발 부트스트랩):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

아직 전역 설치가 없다면 `pnpm openclaw ...`를 통해 CLI를 실행하세요.

이것이 하는 일:

1. **프로필 격리** (전역 `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (따라서 브라우저/캔버스 이동)

2. **개발자 부트스트랩** (`gateway --dev`)
   - 누락된 경우 최소 구성을 작성합니다(`gateway.mode=local`, 루프백 바인딩).
   - `agent.workspace`를 개발 작업 공간으로 설정합니다.
   - `agent.skipBootstrap=true`를 설정합니다(BOOTSTRAP.md 없음).
   - 누락된 경우 작업공간 파일을 시드합니다.
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - 기본 ID: **C3‑PO**(프로토콜 드로이드).
   - 개발 모드에서 채널 제공자를 건너뜁니다(`OPENCLAW_SKIP_CHANNELS=1`).

흐름 재설정(새로 시작):

```bash
pnpm gateway:dev:reset
```

참고: `--dev`는 **전역** 프로필 플래그이며 일부 러너가 먹습니다.
철자를 지정해야 하는 경우 env var 형식을 사용하세요.

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` 구성, 자격 증명, 세션 및 개발 작업 공간을 지웁니다(사용
`trash`가 아니라 `rm`), 기본 개발 설정을 다시 만듭니다.

팁: 비개발 게이트웨이가 이미 실행 중인 경우(launchd/systemd) 먼저 중지하세요.

```bash
openclaw gateway stop
```

## 원시 스트림 로깅(OpenClaw)

OpenClaw는 필터링/포맷하기 전에 **원시 보조 스트림**을 기록할 수 있습니다.
이는 추론이 일반 텍스트 델타로 도착하는지 확인하는 가장 좋은 방법입니다.
(또는 별도의 사고 블록으로).

CLI를 통해 활성화합니다.

```bash
pnpm gateway:watch --force --raw-stream
```

선택적 경로 재정의:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

동등한 환경 변수:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

기본 파일:

`~/.openclaw/logs/raw-stream.jsonl`

## 원시 청크 로깅(pi-mono)

**원시 OpenAI 호환 청크**를 블록으로 파싱하기 전에 캡처하려면,
pi-mono는 별도의 로거를 노출합니다.

```bash
PI_RAW_STREAM=1
```

선택적 경로:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

기본 파일:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 참고: 이는 pi-mono를 사용하는 프로세스에서만 방출됩니다.
> `openai-completions` 제공자.

## 안전 참고사항

- 원시 스트림 로그에는 전체 프롬프트, 도구 출력 및 사용자 데이터가 포함될 수 있습니다.
- 로그를 로컬에 유지하고 디버깅 후 삭제합니다.
- 로그를 공유하는 경우 먼저 비밀과 PII를 삭제하세요.
