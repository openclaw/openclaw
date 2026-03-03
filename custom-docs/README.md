# Pronto-Lab 커스텀 설계 문서

> prontoclaw 포크의 커스텀 기능 설계 및 구현 문서

## planning/ — 진행 중인 설계 문서

| 문서                                                                                            | 내용                                                   | 상태         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------ |
| [OUROBOROS-INTEGRATION-DESIGN.md](./planning/OUROBOROS-INTEGRATION-DESIGN.md)                   | Ouroboros 6-Phase 분리 아키텍처 적용 설계              | 설계 검토 중 |
| [WORKSESSION-COLLAB-DESIGN.md](./planning/WORKSESSION-COLLAB-DESIGN.md)                         | `workSessionId` 기반 3인+ 협업/Conversations 구조 설계 | 설계 검토 중 |
| [deferred-fallback-discord-default-bot.md](./planning/deferred-fallback-discord-default-bot.md) | Discord default bot fallback 설계                      | 설계 검토 중 |

## planning/completed/ — 구현 완료된 설계 문서

| 문서                                                                            | 내용                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------ |
| [HARNESS-EXECUTION-DESIGN.md](./planning/completed/HARNESS-EXECUTION-DESIGN.md) | Harness-Aware Agent Execution 설계         |
| [AGENT-COLLABORATION-V2.md](./planning/completed/AGENT-COLLABORATION-V2.md)     | Agent Collaboration v2 아키텍처            |
| [SISYPHUS-DESIGN.md](./planning/completed/SISYPHUS-DESIGN.md)                   | Sisyphus 패턴 sub-agent orchestration 설계 |
| [TASK-STEPS-DESIGN.md](./planning/completed/TASK-STEPS-DESIGN.md)               | Task Steps + Event-Based Continuation 설계 |
| [IMPLEMENTATION-GUIDE.md](./planning/completed/IMPLEMENTATION-GUIDE.md)         | Sisyphus 패턴 단계별 구현 가이드           |

## 참조 문서

| 문서                                               | 내용                                   |
| -------------------------------------------------- | -------------------------------------- |
| [REFERENCES.md](./REFERENCES.md)                   | 소스 코드 참조, 설정 스냅샷, 서버 환경 |
| [OPERATIONS-RUNBOOK.md](./OPERATIONS-RUNBOOK.md)   | Upstream sync/버전 스큐 방지 운영 런북 |
| [SYSTEM-ARCHITECTURE.md](./SYSTEM-ARCHITECTURE.md) | 시스템 아키텍처 & 데이터 플로우        |

## improvements/ — 아키텍처 개선 설계 문서

- [ARCHITECTURE-IMPROVEMENTS.md](./improvements/ARCHITECTURE-IMPROVEMENTS.md) — 전체 개선 인덱스, 우선순위 매트릭스, 실행 계획
- [01-a2a-conversation-index.md](./improvements/01-a2a-conversation-index.md) — A2A 대화 인덱스 (O(1) 조회)
- [02-a2a-durable-jobs.md](./improvements/02-a2a-durable-jobs.md) — A2A 내구성 잡 큐
- [03-task-tool-modularization.md](./improvements/03-task-tool-modularization.md) — task-tool.ts 모듈화 (2,296 LOC 분리)
- [04-continuation-state-machine.md](./improvements/04-continuation-state-machine.md) — 컨티뉴에이션 상태 머신
- [05-gateway-composition.md](./improvements/05-gateway-composition.md) — Gateway 조합 패턴 (server.impl.ts 분리)
- [06-dependency-injection.md](./improvements/06-dependency-injection.md) — 의존성 주입 체계화
- [07-a2a-concurrency-control.md](./improvements/07-a2a-concurrency-control.md) — A2A 동시성 제어
- [08-structured-handoff.md](./improvements/08-structured-handoff.md) — 구조화된 핸드오프 프로토콜
- [09-coordination-invariants-tests.md](./improvements/09-coordination-invariants-tests.md) — 조정 불변성 테스트
- [10-cross-plane-unification.md](./improvements/10-cross-plane-unification.md) — 크로스 플레인 통합
- [11-subagent-task-lifecycle.md](./improvements/11-subagent-task-lifecycle.md) — 서브에이전트-Task 통합 라이프사이클
- [12-task-enforcement-bypass.md](./improvements/12-task-enforcement-bypass.md) — Task Enforcement Bypass

## 상위 문서

- [PRONTOLAB.md](../PRONTOLAB.md) — 구현 완료된 기능 목록 + 운영 기준 문서

## 관련 리소스

| 리소스      | 위치                                     |
| ----------- | ---------------------------------------- |
| 포크 저장소 | https://github.com/Pronto-Lab/prontoclaw |
| Upstream    | https://github.com/openclaw/openclaw     |
