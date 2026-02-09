---
summary: "에이전트 루프 수명주기, 스트림, 그리고 대기 의미론"
read_when:
  - 에이전트 루프 또는 수명주기 이벤트에 대한 정확한 단계별 설명이 필요할 때
title: "에이전트 루프"
---

# 에이전트 루프 (OpenClaw)

에이전트 루프는 에이전트의 전체 '실제' 실행을 의미합니다. 즉, 입력 → 컨텍스트 구성 → 모델 추론 →
도구 실행 → 응답 스트리밍 → 영속화의 흐름입니다. 이는 메시지를 행동과 최종 응답으로 전환하면서
세션 상태를 일관되게 유지하는 권위 있는 경로입니다.

OpenClaw 에서 루프는 세션당 단일하고 직렬화된 실행이며, 모델이 사고하고, 도구를 호출하고, 출력을 스트리밍하는 동안
수명주기 및 스트림 이벤트를 방출합니다. 이 문서는 그 실제 루프가 처음부터 끝까지 어떻게 연결되는지를 설명합니다.

## 진입점

- Gateway RPC: `agent` 및 `agent.wait`.
- CLI: `agent` 명령.

## 작동 방식 (상위 수준)

1. `agent` RPC 가 매개변수를 검증하고, 세션을 확인(sessionKey/sessionId)하며, 세션 메타데이터를 영속화한 뒤 즉시 `{ runId, acceptedAt }` 를 반환합니다.
2. `agentCommand` 가 에이전트를 실행합니다:
   - 모델 + thinking/verbose 기본값을 결정
   - Skills 스냅샷 로드
   - `runEmbeddedPiAgent` (pi-agent-core 런타임) 호출
   - 내장 루프가 수명주기 종료/오류를 방출하지 않을 경우 **수명주기 종료/오류**를 방출
3. `runEmbeddedPiAgent`:
   - 세션별 + 전역 큐를 통해 실행을 직렬화
   - 모델 + 인증 프로필을 확인하고 pi 세션을 구성
   - pi 이벤트를 구독하고 어시스턴트/도구 델타를 스트리밍
   - 타임아웃을 강제 적용 -> 초과 시 실행 중단
   - 페이로드 + 사용량 메타데이터 반환
4. `subscribeEmbeddedPiSession` 는 pi-agent-core 이벤트를 OpenClaw `agent` 스트림으로 브리지합니다:
   - 도구 이벤트 => `stream: "tool"`
   - 어시스턴트 델타 => `stream: "assistant"`
   - 수명주기 이벤트 => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` 는 `waitForAgentJob` 를 사용합니다:
   - `runId` 에 대해 **수명주기 종료/오류**를 대기
   - `{ status: ok|error|timeout, startedAt, endedAt, error? }` 반환

## 큐잉 + 동시성

- 실행은 세션 키(세션 레인)별로 직렬화되며, 선택적으로 전역 레인을 통과합니다.
- 이는 도구/세션 경합을 방지하고 세션 히스토리를 일관되게 유지합니다.
- 메시징 채널은 이 레인 시스템에 입력되는 큐 모드(collect/steer/followup)를 선택할 수 있습니다.
  자세한 내용은 [Command Queue](/concepts/queue)를 참고하십시오.

## 세션 + 워크스페이스 준비

- 워크스페이스를 확인하고 생성합니다. 샌드박스화된 실행의 경우 샌드박스 워크스페이스 루트로 리디렉션될 수 있습니다.
- Skills 를 로드(또는 스냅샷에서 재사용)하여 환경과 프롬프트에 주입합니다.
- 부트스트랩/컨텍스트 파일을 확인하여 시스템 프롬프트 리포트에 주입합니다.
- 세션 쓰기 락을 획득하며, 스트리밍 전에 `SessionManager` 을 열고 준비합니다.

## 프롬프트 구성 + 시스템 프롬프트

- 시스템 프롬프트는 OpenClaw 기본 프롬프트, Skills 프롬프트, 부트스트랩 컨텍스트, 실행별 오버라이드를 조합하여 생성됩니다.
- 모델별 한계와 컴팩션 예약 토큰이 강제 적용됩니다.
- 모델이 실제로 보는 내용은 [System prompt](/concepts/system-prompt)를 참고하십시오.

## 훅 포인트 (개입 가능한 지점)

OpenClaw 에는 두 가지 훅 시스템이 있습니다:

- **내부 훅** (Gateway 훅): 명령 및 수명주기 이벤트를 위한 이벤트 기반 스크립트.
- **플러그인 훅**: 에이전트/도구 수명주기와 게이트웨이 파이프라인 내부의 확장 지점.

### 내부 훅 (Gateway 훅)

- **`agent:bootstrap`**: 시스템 프롬프트가 확정되기 전에 부트스트랩 파일을 구성하는 동안 실행됩니다.
  이를 사용해 부트스트랩 컨텍스트 파일을 추가/제거할 수 있습니다.
- **명령 훅**: `/new`, `/reset`, `/stop`, 그리고 기타 명령 이벤트 (Hooks 문서 참고).

설정과 예시는 [Hooks](/automation/hooks)를 참고하십시오.

### 플러그인 훅 (에이전트 + 게이트웨이 수명주기)

이 훅들은 에이전트 루프 또는 게이트웨이 파이프라인 내부에서 실행됩니다:

- **`before_agent_start`**: 실행 시작 전에 컨텍스트를 주입하거나 시스템 프롬프트를 오버라이드합니다.
- **`agent_end`**: 완료 후 최종 메시지 목록과 실행 메타데이터를 검사합니다.
- **`before_compaction` / `after_compaction`**: 컴팩션 사이클을 관찰하거나 주석을 추가합니다.
- **`before_tool_call` / `after_tool_call`**: 도구 매개변수/결과를 가로챕니다.
- **`tool_result_persist`**: 세션 전사에 기록되기 전에 도구 결과를 동기적으로 변환합니다.
- **`message_received` / `message_sending` / `message_sent`**: 인바운드 + 아웃바운드 메시지 훅.
- **`session_start` / `session_end`**: 세션 수명주기 경계.
- **`gateway_start` / `gateway_stop`**: 게이트웨이 수명주기 이벤트.

훅 API 와 등록 세부사항은 [Plugins](/tools/plugin#plugin-hooks)를 참고하십시오.

## 스트리밍 + 부분 응답

- 어시스턴트 델타는 pi-agent-core 에서 스트리밍되어 `assistant` 이벤트로 방출됩니다.
- 블록 스트리밍은 `text_end` 또는 `message_end` 에서 부분 응답을 방출할 수 있습니다.
- 추론 스트리밍은 별도의 스트림으로 또는 블록 응답 형태로 방출될 수 있습니다.
- 청킹 및 블록 응답 동작은 [Streaming](/concepts/streaming)을 참고하십시오.

## 도구 실행 + 메시징 도구

- 도구 시작/업데이트/종료 이벤트는 `tool` 스트림으로 방출됩니다.
- 도구 결과는 로깅/방출 전에 크기 및 이미지 페이로드에 대해 정제됩니다.
- 메시징 도구 전송은 중복 어시스턴트 확인을 억제하기 위해 추적됩니다.

## 응답 구성 + 억제

- 최종 페이로드는 다음으로 구성됩니다:
  - 어시스턴트 텍스트 (및 선택적 추론)
  - 인라인 도구 요약 (verbose 이고 허용된 경우)
  - 모델 오류 시 어시스턴트 오류 텍스트
- `NO_REPLY` 는 무음 토큰으로 취급되며 외부로 나가는 페이로드에서 필터링됩니다.
- 메시징 도구 중복은 최종 페이로드 목록에서 제거됩니다.
- 렌더링 가능한 페이로드가 남지 않았고 도구 오류가 발생한 경우, 대체 도구 오류 응답이 방출됩니다
  (메시징 도구가 이미 사용자에게 보이는 응답을 전송한 경우는 제외).

## 컴팩션 + 재시도

- 자동 컴팩션은 `compaction` 스트림 이벤트를 방출하며 재시도를 트리거할 수 있습니다.
- 재시도 시, 중복 출력 방지를 위해 메모리 내 버퍼와 도구 요약이 초기화됩니다.
- 컴팩션 파이프라인은 [Compaction](/concepts/compaction)을 참고하십시오.

## 이벤트 스트림 (현재)

- `lifecycle`: `subscribeEmbeddedPiSession` 에 의해 방출됨 (및 대체 경로로 `agentCommand`)
- `assistant`: pi-agent-core 에서 스트리밍되는 델타
- `tool`: pi-agent-core 에서 스트리밍되는 도구 이벤트

## 채팅 채널 처리

- 어시스턴트 델타는 채팅 `delta` 메시지로 버퍼링됩니다.
- 채팅 `final` 는 **수명주기 종료/오류** 시 방출됩니다.

## 타임아웃

- `agent.wait` 기본값: 30초 (대기만). `timeoutMs` 매개변수로 오버라이드합니다.
- 에이전트 런타임: `agents.defaults.timeoutSeconds` 기본값 600초; `runEmbeddedPiAgent` 중단 타이머에서 강제 적용됩니다.

## 조기에 종료될 수 있는 지점

- 에이전트 타임아웃 (중단)
- AbortSignal (취소)
- Gateway 연결 해제 또는 RPC 타임아웃
- `agent.wait` 타임아웃 (대기 전용, 에이전트는 중단하지 않음)
