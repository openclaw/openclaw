---
summary: "에이전트 루프 라이프사이클, 스트림, 대기 의미론"
read_when:
  - 에이전트 루프 또는 라이프사이클 이벤트의 정확한 워크스루가 필요할 때
title: "에이전트 루프"
---

# 에이전트 루프 (OpenClaw)

agentic 루프는 에이전트의 전체 "진정한" 실행입니다: intake → context assembly → model inference →
tool execution → streaming replies → persistence. 메시지를 작업 및 최종 응답으로 변환하면서 세션 상태를 일관되게 유지하는 신뢰할 수 있는 경로입니다.

OpenClaw에서 루프는 라이프사이클 및 스트림 이벤트를 내보내는 세션별 단일 직렬화된 실행입니다
모델이 생각하고, 도구를 호출하고, 출력을 스트리밍합니다. 이 문서는 진정한 루프가 end-to-end로 어떻게 연결되는지 설명합니다.

## 진입점

- Gateway RPC: `agent` 및 `agent.wait`.
- CLI: `agent` 명령.

## 작동 방식 (고수준)

1. `agent` RPC는 params를 검증하고, 세션 (sessionKey/sessionId)을 해결하고, 세션 메타데이터를 유지하고, `{ runId, acceptedAt }`를 즉시 반환합니다.
2. `agentCommand`는 에이전트를 실행합니다:
   - 모델 + thinking/verbose 기본값 해결
   - 스킬 스냅샷 로드
   - `runEmbeddedPiAgent` 호출 (pi-agent-core 런타임)
   - embedded 루프가 하나를 내보내지 않으면 **lifecycle end/error** 내보냄
3. `runEmbeddedPiAgent`:
   - per-session + global 큐를 통해 실행 직렬화
   - 모델 + auth 프로필 해결 및 pi 세션 빌드
   - pi 이벤트 구독 및 어시스턴트/도구 deltas 스트리밍
   - 초과 시간 강제 -> 초과 시 실행 중단
   - 페이로드 + 사용 메타데이터 반환
4. `subscribeEmbeddedPiSession` pi-agent-core 이벤트를 OpenClaw `agent` 스트림으로 브리지:
   - 도구 이벤트 => `stream: "tool"`
   - 어시스턴트 deltas => `stream: "assistant"`
   - 라이프사이클 이벤트 => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait`는 `waitForAgentJob` 사용:
   - **lifecycle end/error** for `runId` 대기
   - `{ status: ok|error|timeout, startedAt, endedAt, error? }` 반환

## 큐잉 + 동시성

- 실행은 세션 키 (session lane) 당 그리고 선택적으로 global lane을 통해 직렬화됩니다.
- 이는 도구/세션 races를 방지하고 세션 히스토리를 일관되게 유지합니다.
- 메시징 채널은 이 lane 시스템을 공급하는 큐 모드 (collect/steer/followup)를 선택할 수 있습니다.
  [명령 큐](/concepts/queue) 참조.

## 세션 + 워크스페이스 준비

- 워크스페이스는 해결 및 생성됩니다; 샌드박스된 실행은 샌드박스 워크스페이스 루트로 리디렉션될 수 있습니다.
- 스킬은 로드되거나 (또는 스냅샷에서 재사용됨) 환경 및 프롬프트에 주입됩니다.
- Bootstrap/context 파일은 해결되고 시스템 프롬프트 보고서에 주입됩니다.
- 세션 쓰기 잠금이 획득됩니다; `SessionManager`는 스트리밍 전에 열리고 준비됩니다.

## 프롬프트 조립 + 시스템 프롬프트

- 시스템 프롬프트는 OpenClaw의 기본 프롬프트, 스킬 프롬프트, bootstrap 컨텍스트 및 per-run 재정의로부터 빌드됩니다.
- 모델별 제한 및 compaction reserve tokens이 강제됩니다.
- 모델이 보는 것에 대해서는 [시스템 프롬프트](/concepts/system-prompt)를 참조하세요.

## Hook 포인트 (인터셉트할 수 있는 곳)

OpenClaw는 두 가지 hook 시스템을 갖습니다:

- **Internal hooks** (Gateway hooks): 명령 및 라이프사이클 이벤트에 대한 event-driven 스크립트.
- **Plugin hooks**: 에이전트/도구 라이프사이클 및 gateway 파이프라인 내의 확장 포인트.

### Internal hooks (Gateway hooks)

- **`agent:bootstrap`**: bootstrap 파일이 시스템 프롬프트 최종화 전에 빌드되는 동안 실행됩니다.
  이를 사용하여 bootstrap context 파일을 추가/제거하세요.
- **Command hooks**: `/new`, `/reset`, `/stop` 및 기타 명령 이벤트 (Hooks doc 참조).

[Hooks](/automation/hooks)에서 설정 및 예제를 참조하세요.

### Plugin hooks (agent + gateway lifecycle)

이들은 에이전트 루프 또는 gateway 파이프라인 내에서 실행됩니다:

- **`before_model_resolve`**: session (메시지 없음) 전에 실행되어 model resolution 전에 provider/model을 결정론적으로 재정의합니다.
- **`before_prompt_build`**: session load 후 (메시지 포함) 실행되어 prompt submission 전에 `prependContext`/`systemPrompt`를 주입합니다.
- **`before_agent_start`**: 어느 쪽 phase든 실행될 수 있는 legacy compatibility hook; 위의 명시적 hooks를 선호하세요.
- **`agent_end`**: 완료 후 최종 메시지 리스트 및 실행 메타데이터를 검사합니다.
- **`before_compaction` / `after_compaction`**: compaction 사이클을 관찰하거나 주석을 붙입니다.
- **`before_tool_call` / `after_tool_call`**: tool params/results를 인터셉트합니다.
- **`tool_result_persist`**: 도구 결과가 세션 트랜스크립트에 기록되기 전에 동기적으로 변환합니다.
- **`message_received` / `message_sending` / `message_sent`**: inbound + outbound message hooks.
- **`session_start` / `session_end`**: session lifecycle 경계.
- **`gateway_start` / `gateway_stop`**: gateway lifecycle 이벤트.

Hook API 및 등록 세부정보는 [Plugins](/tools/plugin#plugin-hooks)를 참조하세요.

## 스트리밍 + partial 응답

- 어시스턴트 deltas는 pi-agent-core에서 스트리밍되고 `assistant` 이벤트로 내보내집니다.
- 블록 스트리밍은 partial 응답을 `text_end` 또는 `message_end`에 내보낼 수 있습니다.
- Reasoning 스트리밍은 별도의 스트림으로 또는 블록 응답으로 내보내질 수 있습니다.
- 청킹 및 블록 응답 동작은 [스트리밍](/concepts/streaming)를 참조하세요.

## 도구 실행 + 메시징 도구

- 도구 start/update/end 이벤트는 `tool` 스트림에서 내보내집니다.
- 도구 결과는 logging/emitting 전에 크기 및 이미지 페이로드에 대해 살균됩니다.
- 메시징 도구 전송은 중복된 어시스턴트 확인을 억제하기 위해 추적됩니다.

## 응답 형성 + 억제

- 최종 페이로드는 다음으로 조립됩니다:
  - 어시스턴트 텍스트 (및 선택적 reasoning)
  - inline tool 요약 (verbose + 허용되는 경우)
  - 모델 오류 시 어시스턴트 오류 텍스트
- `NO_REPLY`는 silent token로 처리되고 outgoing 페이로드에서 필터링됩니다.
- 메시징 도구 중복은 최종 페이로드 리스트에서 제거됩니다.
- 렌더 가능한 페이로드가 남지 않고 도구 오류가 발생한 경우, fallback tool error reply가 내보내집니다
  (메시징 도구가 이미 user-visible 응답을 전송하지 않은 한).

## Compaction + 재시도

- Auto-compaction은 `compaction` 스트림 이벤트를 내보내고 재시도를 trigger할 수 있습니다.
- 재시도에서 in-memory 버퍼 및 도구 요약은 중복된 출력을 피하기 위해 재설정됩니다.
- Compaction 파이프라인은 [Compaction](/concepts/compaction)를 참조하세요.

## 이벤트 스트림 (현재)

- `lifecycle`: `subscribeEmbeddedPiSession`에서 내보내짐 (및 `agentCommand`의 fallback)
- `assistant`: pi-agent-core에서 스트림된 deltas
- `tool`: pi-agent-core에서 스트림된 도구 이벤트

## 채팅 채널 처리

- 어시스턴트 deltas는 채팅 `delta` 메시지로 버퍼됩니다.
- 채팅 `final`은 **lifecycle end/error**에서 내보내집니다.

## 타임아웃

- `agent.wait` 기본값: 30s (wait만). `timeoutMs` param은 재정의합니다.
- 에이전트 런타임: `agents.defaults.timeoutSeconds` 기본값 600s; `runEmbeddedPiAgent` abort timer에서 강제됩니다.

## 조기에 끝날 수 있는 곳

- 에이전트 타임아웃 (abort)
- AbortSignal (cancel)
- Gateway disconnect 또는 RPC timeout
- `agent.wait` 타임아웃 (wait만, agent를 중지하지 않음)
