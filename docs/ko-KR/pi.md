---
title: "Pi 통합 아키텍처"
summary: "OpenClaw의 포함된 Pi 에이전트 통합 및 세션 수명 주기 아키텍처"
read_when:
  - OpenClaw에서 Pi SDK 통합 설계를 이해할 때
  - Pi에 대한 에이전트 세션 수명 주기, 도구 또는 제공자 배선을 수정할 때
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/pi.md"
  workflow: 15
---

# Pi 통합 아키텍처

이 문서는 OpenClaw가 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 및 형제 패키지(`pi-ai`, `pi-agent-core`, `pi-tui`)와 통합되어 AI 에이전트 기능을 제공하는 방식을 설명합니다.

## 개요

OpenClaw는 pi SDK를 사용하여 AI 코딩 에이전트를 메시징 게이트웨이 아키텍처에 포함합니다. OpenClaw는 pi를 서브프로세스로 생성하거나 RPC 모드를 사용하는 대신 `createAgentSession()`을 통해 pi의 `AgentSession`을 직접 가져오고 인스턴스화합니다. 이 포함된 접근 방식은 다음을 제공합니다:

- 세션 수명 주기 및 이벤트 처리에 대한 전체 제어
- 메시징, 샌드박스, 채널 특정 작업 등 사용자 정의 도구 주입
- 채널/컨텍스트별 시스템 프롬프트 사용자 정의
- 분기/압축 지원이 있는 세션 지속성
- 폴백이 있는 다중 계정 인증 프로필 회전
- 제공자 독립적 모델 전환

## 패키지 종속성

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| 패키지            | 목적                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `pi-ai`           | 핵심 LLM 추상화: `Model`, `streamSimple`, 메시지 유형, 제공자 API                           |
| `pi-agent-core`   | 에이전트 루프, 도구 실행, `AgentMessage` 유형                                               |
| `pi-coding-agent` | 고급 SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, 내장 도구 |
| `pi-tui`          | 터미널 UI 구성 요소 (OpenClaw의 로컬 TUI 모드에 사용됨)                                     |

(이하 내용이 매우 길어서 요약본으로 제공됩니다. 전체 내용은 원본 파일을 참조하세요)

## 핵심 통합 흐름

### 1. 포함된 에이전트 실행

주요 진입점은 `pi-embedded-runner/run.ts`의 `runEmbeddedPiAgent()`입니다.

### 2. 세션 생성

`runEmbeddedAttempt()` 내에서 pi SDK가 사용됩니다.

### 3. 이벤트 구독

`subscribeEmbeddedPiSession()`은 pi의 `AgentSession` 이벤트를 구독합니다:

- `message_start` / `message_end` / `message_update` (스트리밍 텍스트/생각)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. 프롬프팅

설정 후 세션이 프롬프트됩니다:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK는 전체 에이전트 루프를 처리합니다: LLM으로 전송, 도구 호출 실행, 응답 스트리밍.

## 도구 아키텍처

### 도구 파이프라인

1. **기본 도구**: pi의 `codingTools` (read, bash, edit, write)
2. **사용자 정의 교체**: OpenClaw가 bash를 `exec`/`process`로 교체, 샌드박스에 대해 read/edit/write 사용자 정의
3. **OpenClaw 도구**: 메시징, 브라우저, 캔버스, 세션, cron, gateway 등
4. **채널 도구**: Discord/Telegram/Slack/WhatsApp 특정 작업 도구
5. **정책 필터링**: 프로필, 제공자, 에이전트, 그룹, 샌드박스 정책으로 필터링된 도구
6. **스키마 정규화**: Gemini/OpenAI 특이성에 대해 정리된 스키마
7. **AbortSignal 래핑**: 중단 신호를 존중하도록 래핑된 도구

## 인증 및 모델 해결

### 인증 프로필

OpenClaw는 제공자당 여러 API 키를 사용하는 인증 프로필 저장소를 유지합니다.

### 모델 해결

```typescript
import { resolveModel } from "./pi-embedded-runner/model.js";

const { model, error, authStorage, modelRegistry } = resolveModel(
  provider,
  modelId,
  agentDir,
  config,
);
```

### 폴백

`FailoverError`는 구성된 경우 모델 폴백을 트리거합니다.

## 이전 Pi CLI와의 주요 차이점

| 측면            | Pi CLI                  | OpenClaw 포함                            |
| --------------- | ----------------------- | ---------------------------------------- |
| 호출            | `pi` 명령 / RPC         | SDK를 통해 `createAgentSession()`        |
| 도구            | 기본 코딩 도구          | 사용자 정의 OpenClaw 도구 모음           |
| 시스템 프롬프트 | AGENTS.md + 프롬프트    | 채널/컨텍스트별 동적                     |
| 세션 저장소     | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<agentId>/sessions/` |
| 인증            | 단일 자격증명           | 폴백이 있는 다중 프로필                  |
| 확장            | 디스크에서 로드됨       | 프로그래매틱 + 디스크 경로               |
| 이벤트 처리     | TUI 렌더링              | 콜백 기반 (onBlockReply, 등)             |

## 테스트

Pi 통합 적용 범위는 다음 스위트에 걸쳐 있습니다:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-extensions/**/*.test.ts`

라이브/옵트인:

- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (enable `OPENCLAW_LIVE_TEST=1`)

현재 실행 명령은 [Pi 개발 워크플로우](/pi-dev)를 참조하세요.
