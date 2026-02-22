---
summary: "디버깅 도구: 감시 모드, 원시 모델 스트림, 그리고 추론 누출 추적"
read_when:
  - 추론 누출을 위해 원시 모델 출력을 검사해야 할 때
  - 반복하면서 게이트웨이를 감시 모드로 실행하고 싶을 때
  - 반복 가능한 디버깅 워크플로우가 필요할 때
title: "디버깅"
---

# 디버깅

이 페이지는 스트리밍 출력에 대한 디버깅 도우미를 다루며, 특히 프로바이더가 일반 텍스트에 추론을 섞을 때 유용합니다.

## 런타임 디버그 오버라이드

**런타임 전용** 구성 오버라이드를 설정하기 위해 채팅에서 `/debug`를 사용하세요 (메모리, 디스크 아님). `/debug`는 기본적으로 비활성화되어 있으며, `commands.debug: true`로 활성화할 수 있습니다. 이는 `openclaw.json`을 편집하지 않고도 숨겨진 설정을 전환해야 할 때 유용합니다.

예시:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset`은 모든 오버라이드를 제거하고 디스크에 저장된 구성으로 되돌립니다.

## 게이트웨이 감시 모드

빠른 반복을 위해 파일 감시자에서 게이트웨이를 실행하세요:

```bash
pnpm gateway:watch
```

이는 다음과 같이 매핑됩니다:

```bash
node --watch-path src --watch-path tsconfig.json --watch-path package.json --watch-preserve-output scripts/run-node.mjs gateway --force
```

`gateway:watch` 뒤에 게이트웨이 CLI 플래그를 추가하면 각 재시작 시 전달됩니다.

## 개발 프로필 + 개발 게이트웨이 (--dev)

상태를 분리하고 안전하며 일회용 설정을 위해 디버깅을 설정하는 데 개발 프로필을 사용하세요. **두 가지** `--dev` 플래그가 있습니다:

- **전역 `--dev` (프로필):** 상태를 `~/.openclaw-dev` 아래에 분리하고 게이트웨이 포트를 `19001`로 기본 설정합니다 (파생 포트도 이에 따라 변합니다).
- **`gateway --dev`:** 게이트웨이가 기본 설정 + 워크스페이스를 자동 생성하도록 지시합니다 (그리고 BOOTSTRAP.md를 건너뜁니다).

추천 흐름 (개발 프로필 + 개발 부트스트랩):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

아직 전역 설치가 없으면, `pnpm openclaw ...`를 통해 CLI를 실행하십시오.

이렇게 하면 다음과 같은 작업이 수행됩니다:

1. **프로필 분리** (전역 `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (브라우저/캔버스도 이에 따라 변경됨)

2. **개발 부트스트랩** (`gateway --dev`)
   - 누락 시 최소 구성 작성 (`gateway.mode=local`, 루프백 바인딩).
   - `agent.workspace`를 개발 워크스페이스로 설정.
   - `agent.skipBootstrap=true` 설정 (BOOTSTRAP.md 없음).
   - 누락 시 워크스페이스 파일 시딩:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - 기본 아이덴티티: **C3‑PO** (프로토콜 드로이드).
   - 개발 모드에서 채널 프로바이더 건너뛰기 (`OPENCLAW_SKIP_CHANNELS=1`).

재설정 흐름 (새로운 시작):

```bash
pnpm gateway:dev:reset
```

참고: `--dev`는 **전역** 프로필 플래그이며, 일부 실행기에서 흡수됩니다. 이를 명확히 하기 위해 ENV 변수를 사용하세요:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset`은 구성, 자격 증명, 세션, 개발 워크스페이스를 지우고 (휴지통 사용, `rm` 아님), 기본 개발 설정을 다시 만듭니다.

팁: 비개발 게이트웨이가 이미 실행 중인 경우 (launchd/systemd) 먼저 중지하세요:

```bash
openclaw gateway stop
```

## 원시 스트림 로깅 (OpenClaw)

OpenClaw는 필터링/형식 지정 전에 **원시 어시스턴트 스트림**을 기록할 수 있습니다. 이는 추론이 일반 텍스트 델타로 도달하는지 (아니면 별도의 사고 블록으로 도달하는지) 확인하기 위한 최상의 방법입니다.

CLI를 통해 활성화:

```bash
pnpm gateway:watch --raw-stream
```

선택적 경로 오버라이드:

```bash
pnpm gateway:watch --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

동등한 환경 변수:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

기본 파일:

`~/.openclaw/logs/raw-stream.jsonl`

## 원시 청크 로깅 (pi-mono)

블록으로 파싱되기 전에 **원시 OpenAI 호환 청크**를 캡처하려면, pi-mono는 별도의 로거를 노출합니다:

```bash
PI_RAW_STREAM=1
```

선택적 경로:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

기본 파일:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 참고: 이는 pi-mono의 `openai-completions` 프로바이더를 사용하는 프로세스에서만 만들어집니다.

## 안전 주의사항

- 원시 스트림 로그에는 전체 프롬프트, 도구 출력, 사용자 데이터가 포함될 수 있습니다.
- 로컬에 로그를 보관하고 디버깅 후 삭제하세요.
- 로그를 공유할 경우, 먼저 비밀 정보와 개인정보를 제거하세요.
