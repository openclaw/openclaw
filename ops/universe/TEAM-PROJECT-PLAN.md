# Team Project Dispatch Plan (MAI Universe Platform v1)

## Status

- Created: 2026-02-26
- Owner: MAIBOT-Orchestrator
- Mode: Parallel sub-agent execution

## Mission

MAI Universe 아키텍처를 문서 기준으로 실제 운영체계로 전환한다.

## Workstreams

### WS-1 Governance Hardening

- Owner: Auditor Agent
- Deliverables:
  - policy-matrix v1 검증
  - 승인 게이트 체크리스트 템플릿
  - 고위험 액션 감사 로그 포맷

### WS-2 Registry Expansion

- Owner: Analyst Agent
- Deliverables:
  - 16개 프로젝트 전체 registry 등록
  - 초기 health/contrib/revenue/risk 점수 입력
  - 주간 리밸런싱 규칙 정의

### WS-3 Orchestration Runbook

- Owner: Operator Agent
- Deliverables:
  - 일간/주간 운영 루틴
  - 장애 대응(runbook) + 재시도 정책
  - Discord 브리핑 템플릿

### WS-4 Automation Hooks

- Owner: Builder Agent
- Deliverables:
  - run-ledger 기록 스크립트 초안
  - KPI 집계 스크립트 초안
  - 레포별 상태 수집 스크립트 초안

## Two-Week Target

- Week 1: 정책/레지스트리/로그 규격 고정
- Week 2: 자동 수집 + 주간 리포트 파일 자동 생성

## Done Criteria

- [ ] WS-1~WS-4 산출물 완료
- [ ] 주간 리포트 1회 자동 생성 성공
- [ ] 승인 게이트 테스트 케이스 통과
