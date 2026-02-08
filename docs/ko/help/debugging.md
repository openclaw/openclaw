---
read_when:
    - 누출을 추론하려면 원시 모델 출력을 검사해야 합니다.
    - 반복하는 동안 감시 모드에서 게이트웨이를 실행하려고 합니다.
    - 반복 가능한 디버깅 작업 흐름이 필요합니다.
summary: '디버깅 도구: 감시 모드, 원시 모델 스트림 및 추론 누출 추적'
title: 디버깅
x-i18n:
    generated_at: "2026-02-08T15:56:07Z"
    model: gtx
    provider: google-translate
    source_hash: 504c824bff4790006c8b73600daca66b919e049178e9711e6e65b6254731911a
    source_path: help/debugging.md
    workflow: 15
---

# 디버깅

이 페이지에서는 특히 스트리밍 출력을 위한 디버깅 도우미에 대해 설명합니다.
공급자는 추론을 일반 텍스트에 혼합합니다.

## 런타임 디버그 재정의

사용 `/debug` 채팅에서 설정 **런타임 전용** 구성 재정의(디스크가 아닌 메모리)
`/debug` 기본적으로 비활성화되어 있습니다. 활성화 `commands.debug: true`.
이는 편집하지 않고 모호한 설정을 전환해야 할 때 유용합니다. `openclaw.json`.

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

이후에 게이트웨이 CLI 플래그를 추가하세요. `gateway:watch` 그리고 그들은 통과될 것이다
다시 시작할 때마다.

## 개발 프로필 + 개발 게이트웨이(--dev)

개발 프로필을 사용하여 상태를 분리하고 안전하고 일회용 설정을 시작하세요.
디버깅. 있다 **둘** `--dev` 플래그:

- **글로벌 `--dev` (윤곽):** 상태를 다음과 같이 격리합니다. `~/.openclaw-dev` 그리고
  게이트웨이 포트는 기본적으로 `19001` (파생 포트도 함께 이동합니다).
- **`gateway --dev`: 게이트웨이에 기본 구성을 자동 생성하도록 지시합니다. +
  작업 공간** 누락된 경우(BOOTSTRAP.md 건너뛰기)

권장 흐름(개발자 프로필 + 개발 부트스트랩):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

아직 전역 설치가 없다면 다음을 통해 CLI를 실행하세요. `pnpm openclaw ...`.

이것이 하는 일:

1. **프로필 격리** (글로벌 `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (따라서 브라우저/캔버스 이동)

2. **개발 부트스트랩** (`gateway --dev`)
   - 누락된 경우 최소 구성을 작성합니다(`gateway.mode=local`, 바인딩 루프백).
   - 세트 `agent.workspace` 개발 작업 공간으로.
   - 세트 `agent.skipBootstrap=true` (BOOTSTRAP.md 없음).
   - 누락된 경우 작업공간 파일을 시드합니다.
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - 기본 ID: **C3-PO** (프로토콜 드로이드).
   - 개발 모드에서 채널 제공자를 건너뜁니다(`OPENCLAW_SKIP_CHANNELS=1`).

흐름 재설정(새로 시작):

```bash
pnpm gateway:dev:reset
```

메모: `--dev` 는 **글로벌** 프로필 플래그가 표시되고 일부 주자들이 잡아먹습니다.
철자를 지정해야 하는 경우 env var 형식을 사용하세요.

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` 구성, 자격 증명, 세션 및 개발 작업 공간을 지웁니다(사용
`trash`, 아니다 `rm`), 그런 다음 기본 개발 설정을 다시 만듭니다.

팁: 비개발 게이트웨이가 이미 실행 중인 경우(launchd/systemd) 먼저 중지하세요.

```bash
openclaw gateway stop
```

## 원시 스트림 로깅(OpenClaw)

OpenClaw는 다음을 기록할 수 있습니다. **원시 어시스턴트 스트림** 필터링/포맷하기 전에.
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

캡처하려면 **원시 OpenAI 호환 청크** 블록으로 파싱되기 전에
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

> 참고: 이는 pi-mono를 사용하는 프로세스에서만 발생합니다.
> `openai-completions` 공급자.

## 안전 참고사항

- 원시 스트림 로그에는 전체 프롬프트, 도구 출력 및 사용자 데이터가 포함될 수 있습니다.
- 로그를 로컬에 유지하고 디버깅 후 삭제하세요.
- 로그를 공유하는 경우 먼저 비밀과 PII를 삭제하세요.
