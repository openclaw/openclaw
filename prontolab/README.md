# Pronto-Lab 커스텀 설계 문서

> prontolab-openclaw 포크의 커스텀 기능 설계 및 구현 문서 보관소

## 문서 목록

| 문서                                                           | 내용                                                   | 상태                                    |
| -------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| [SISYPHUS-DESIGN.md](./SISYPHUS-DESIGN.md)                     | Sisyphus 패턴 sub-agent orchestration 설계             | 핵심 구조 반영, 운영 문서로 유지        |
| [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md)           | Sisyphus 패턴 단계별 구현 가이드                       | 주요 단계 반영 완료, 검증 기준 문서     |
| [REFERENCES.md](./REFERENCES.md)                               | 소스 코드 참조, 설정 스냅샷, 서버 환경                 | 참조 문서                               |
| [TASK-STEPS-DESIGN.md](./TASK-STEPS-DESIGN.md)                 | Task Steps + Event-Based Continuation 설계             | 핵심 로직 구현, 모니터링 연동 확장 가능 |
| [OPERATIONS-RUNBOOK.md](./OPERATIONS-RUNBOOK.md)               | Upstream sync/버전 스큐 방지 운영 런북                 | 운영 문서                               |
| [WORKSESSION-COLLAB-DESIGN.md](./WORKSESSION-COLLAB-DESIGN.md) | `workSessionId` 기반 3인+ 협업/Conversations 구조 설계 | 설계 문서 (구현 전 검토용)              |

## 상위 문서

- [PRONTOLAB.md](../PRONTOLAB.md) — 구현 완료된 기능 목록 + 운영 기준 문서
- [OPERATIONS-RUNBOOK.md](./OPERATIONS-RUNBOOK.md) — PRONTOLAB 운영 절차를 prontolab 디렉토리에 동기화한 문서

## 이 디렉토리의 목적

`PRONTOLAB.md`는 **운영 기준 + 구현 완료 내역**을 기록하는 상위 문서입니다.
`prontolab/`은 **설계 문서 + 구현 반영 문서 + 운영 런북**을 함께 보관합니다.

기능이 구현 완료되면:

1. `PRONTOLAB.md`에 구현 완료 기록 추가
2. `prontolab/` 설계 문서에 구현 상태 업데이트

## 관련 리소스

| 리소스         | 위치                                             |
| -------------- | ------------------------------------------------ |
| 원본 설계 문서 | `/tmp/openclaw-final-design/` (서버 로컬)        |
| 포크 저장소    | https://github.com/Pronto-Lab/prontolab-openclaw |
| Upstream       | https://github.com/openclaw/openclaw             |
| 서버           | Mac Mini (내부 네트워크)                         |

---

_작성일: 2026-02-13_
