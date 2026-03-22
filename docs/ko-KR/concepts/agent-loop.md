---
summary: "에이전트 루프 라이프사이클, 스트림 및 대기 시맨틱"
read_when:
  - 에이전트 루프 또는 라이프사이클 이벤트의 정확한 워크스루가 필요할 때
title: "에이전트 루프"
x-i18n:
  source_path: "docs/concepts/agent-loop.md"
---

# 에이전트 루프 (OpenClaw)

에이전트 루프는 에이전트의 전체 "실제" 실행입니다: 입력 → 컨텍스트 조립 → 모델 추론 → 도구 실행 → 스트리밍 응답 → 영속화. 메시지를 액션과 최종 응답으로 변환하면서 세션 상태를 일관되게 유지하는 권위 있는 경로입니다.

OpenClaw에서 루프는 모델이 생각하고, 도구를 호출하고, 출력을 스트리밍하는 동안 라이프사이클 및 스트림 이벤트를 발생시키는 세션당 단일 직렬화된 실행입니다. 이 문서에서는 이 진정한 루프가 어떻게 엔드 투 엔드로 연결되는지 설명합니다.

## 진입점

- Gateway RPC: `agent` 및 `agent.wait`.
- CLI: `agent` 명령.

## 작동 방식 (상위 수준)

1. `agent` RPC가 매개변수를 검증하고, 세션(sessionKey/sessionId)을 확인하고, 세션 메타데이터를 영속화한 후, 즉시 `{ runId, acceptedAt }`을 반환합니다.
2. `agentCommand`가 에이전트를 실행합니다:
   - 모델 + thinking/verbose 기본값 확인
   - Skills 스냅샷 로드
   - `runEmbeddedPiAgent` (pi-agent-core 런타임) 호출
   - 내장 루프가 발생시키지 않는 경우 **라이프사이클 end/error** 발생
3. `runEmbeddedPiAgent`:
   - 세션별 + 전역 대기열을 통해 실행 직렬화
   - 모델 + 인증 프로필을 확인하고 pi 세션 구축
   - pi 이벤트를 구독하고 어시스턴트/도구 델타 스트리밍
   - 타임아웃 적용 -> 초과 시 실행 중단
   - 페이로드 + 사용량 메타데이터 반환
4. `subscribeEmbeddedPiSession`이 pi-agent-core 이벤트를 OpenClaw `agent` 스트림으로 브리지합니다:
   - 도구 이벤트 => `stream: "tool"`
   - 어시스턴트 델타 => `stream: "assistant"`
   - 라이프사이클 이벤트 => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait`는 `waitForAgentJob`을 사용합니다:
   - `runId`에 대한 **라이프사이클 end/error** 대기
   - `{ status: ok|error|timeout, startedAt, endedAt, error? }` 반환

## 대기열 + 동시성

- 실행은 세션 키별(세션 레인)로 직렬화되며 선택적으로 전역 레인을 통해 처리됩니다.
- 이는 도구/세션 경합을 방지하고 세션 기록의 일관성을 유지합니다.
- 메시징 채널은 이 레인 시스템에 공급하는 대기열 모드(collect/steer/followup)를 선택할 수 있습니다.
  [명령 대기열](/concepts/queue)을 참조하세요.

## 세션 + 워크스페이스 준비

- 워크스페이스가 확인되고 생성됩니다. 샌드박스 실행은 샌드박스 워크스페이스 루트로 리디렉션될 수 있습니다.
- Skills가 로드(또는 스냅샷에서 재사용)되어 환경과 프롬프트에 주입됩니다.
- 부트스트랩/컨텍스트 파일이 확인되어 시스템 프롬프트 보고서에 주입됩니다.
- 세션 쓰기 잠금이 획득됩니다. `SessionManager`가 스트리밍 전에 열리고 준비됩니다.

## 프롬프트 조립 + 시스템 프롬프트

- 시스템 프롬프트는 OpenClaw의 기본 프롬프트, Skills 프롬프트, 부트스트랩 컨텍스트 및 실행별 재정의로 구축됩니다.
- 모델별 제한과 압축 예약 토큰이 적용됩니다.
- 모델이 보는 내용은 [시스템 프롬프트](/concepts/system-prompt)를 참조하세요.

## 후크 포인트 (가로채기 가능한 위치)

OpenClaw에는 두 가지 후크 시스템이 있습니다:

- **내부 후크** (Gateway 후크): 명령 및 라이프사이클 이벤트에 대한 이벤트 기반 스크립트.
- **플러그인 후크**: 에이전트/도구 라이프사이클 및 Gateway 파이프라인 내부의 확장 포인트.

### 내부 후크 (Gateway 후크)

- **`agent:bootstrap`**: 시스템 프롬프트가 확정되기 전에 부트스트랩 파일을 빌드하는 동안 실행됩니다. 부트스트랩 컨텍스트 파일을 추가/제거하는 데 사용하세요.
- **명령 후크**: `/new`, `/reset`, `/stop` 및 기타 명령 이벤트 (후크 문서 참조).

설정 및 예제는 [후크](/automation/hooks)를 참조하세요.

### 플러그인 후크 (에이전트 + Gateway 라이프사이클)

에이전트 루프 또는 Gateway 파이프라인 내부에서 실행됩니다:

- **`before_model_resolve`**: 사전 세션(messages 없음)에서 실행되어 모델 확인 전에 프로바이더/모델을 결정적으로 재정의합니다.
- **`before_prompt_build`**: 세션 로드 후(`messages` 포함) 실행되어 프롬프트 제출 전에 `prependContext`, `systemPrompt`, `prependSystemContext` 또는 `appendSystemContext`를 주입합니다. 턴별 동적 텍스트에는 `prependContext`를, 시스템 프롬프트 공간에 있어야 하는 안정적 안내에는 system-context 필드를 사용하세요.
- **`before_agent_start`**: 어느 단계에서든 실행될 수 있는 레거시 호환성 후크입니다. 위의 명시적 후크를 선호하세요.
- **`agent_end`**: 완료 후 최종 메시지 목록과 실행 메타데이터를 검사합니다.
- **`before_compaction` / `after_compaction`**: 압축 사이클을 관찰하거나 주석을 답니다.
- **`before_tool_call` / `after_tool_call`**: 도구 매개변수/결과를 가로챕니다.
- **`tool_result_persist`**: 도구 결과가 세션 트랜스크립트에 기록되기 전에 동기적으로 변환합니다.
- **`message_received` / `message_sending` / `message_sent`**: 수신 + 발신 메시지 후크.
- **`session_start` / `session_end`**: 세션 라이프사이클 경계.
- **`gateway_start` / `gateway_stop`**: Gateway 라이프사이클 이벤트.

후크 API 및 등록 세부 사항은 [플러그인 후크](/plugins/architecture#provider-runtime-hooks)를 참조하세요.

## 스트리밍 + 부분 응답

- 어시스턴트 델타는 pi-agent-core에서 스트리밍되어 `assistant` 이벤트로 발생합니다.
- 블록 스트리밍은 `text_end` 또는 `message_end`에서 부분 응답을 발생시킬 수 있습니다.
- 추론 스트리밍은 별도 스트림 또는 블록 응답으로 발생할 수 있습니다.
- 청킹 및 블록 응답 동작은 [스트리밍](/concepts/streaming)을 참조하세요.

## 도구 실행 + 메시징 도구

- 도구 시작/업데이트/종료 이벤트는 `tool` 스트림에서 발생합니다.
- 도구 결과는 로깅/발생 전에 크기와 이미지 페이로드에 대해 정제됩니다.
- 메시징 도구 전송은 중복 어시스턴트 확인을 억제하기 위해 추적됩니다.

## 응답 형성 + 억제

- 최종 페이로드는 다음에서 조립됩니다:
  - 어시스턴트 텍스트 (및 선택적 추론)
  - 인라인 도구 요약 (verbose + 허용 시)
  - 모델 오류 시 어시스턴트 오류 텍스트
- `NO_REPLY`는 무음 토큰으로 처리되어 발신 페이로드에서 필터링됩니다.
- 메시징 도구 중복은 최종 페이로드 목록에서 제거됩니다.
- 렌더링 가능한 페이로드가 없고 도구에서 오류가 발생한 경우, 폴백 도구 오류 응답이 발생합니다 (메시징 도구가 이미 사용자에게 보이는 응답을 보낸 경우 제외).

## 압축 + 재시도

- 자동 압축은 `compaction` 스트림 이벤트를 발생시키며 재시도를 트리거할 수 있습니다.
- 재시도 시 중복 출력을 방지하기 위해 인메모리 버퍼와 도구 요약이 초기화됩니다.
- 압축 파이프라인은 [압축](/concepts/compaction)을 참조하세요.

## 이벤트 스트림 (현재)

- `lifecycle`: `subscribeEmbeddedPiSession`에 의해 발생 (그리고 `agentCommand`의 폴백으로)
- `assistant`: pi-agent-core에서 스트리밍되는 델타
- `tool`: pi-agent-core에서 스트리밍되는 도구 이벤트

## 채팅 채널 처리

- 어시스턴트 델타는 채팅 `delta` 메시지로 버퍼링됩니다.
- **라이프사이클 end/error** 시 채팅 `final`이 발생합니다.

## 타임아웃

- `agent.wait` 기본값: 30초 (대기만). `timeoutMs` 매개변수로 재정의 가능.
- 에이전트 런타임: `agents.defaults.timeoutSeconds` 기본값 600초; `runEmbeddedPiAgent` 중단 타이머에서 적용.

## 조기 종료 가능 지점

- 에이전트 타임아웃 (중단)
- AbortSignal (취소)
- Gateway 연결 해제 또는 RPC 타임아웃
- `agent.wait` 타임아웃 (대기만, 에이전트를 중지하지 않음)
