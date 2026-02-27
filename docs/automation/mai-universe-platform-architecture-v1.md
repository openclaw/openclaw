# MAI Universe Platform Architecture v1

- Version: v1.0 (확정)
- Date: 2026-02-26 (KST)
- Owner: MAIBOT (Orchestrator)
- Goal: **기여(Contribution)와 수익(Monetization)의 선순환**을 유지하면서 16개 프로젝트를 단일 운영체계로 통합 관리

---

## 1) 설계 원칙 (MAI Universe 철학 반영)

1. **기여와 수익의 동시 최적화**
   - 기여 지표(오픈소스/커뮤니티/콘텐츠)와 수익 지표(MRR/ARR/전환율)를 동시에 본다.
2. **크로스 프로젝트 시너지 우선**
   - 단일 프로젝트 최적화보다 생태계 전체 ROI를 우선한다.
3. **자동화 우선, 승인 기반 통제**
   - 내부 작업은 자동화, 고위험/고비용 작업은 승인 게이트를 통과한다.
4. **재현 가능성**
   - 모든 의사결정/실행은 로그 + 메모리로 재현 가능해야 한다.

---

## 2) 목표 운영 모델: 5-Plane 아키텍처

```text
[Interaction Plane]
Discord / MAIBOTALKS / Web / CLI
            │
            ▼
[Control Plane - MAIBOT Kernel]
Intent Parser → Planner → Policy Engine → Agent Scheduler
            │
      ┌─────┴─────┐
      ▼           ▼
[Execution Plane] [Knowledge Plane]
Project Pods      Memory + Mnemo + Web
(Repo/Test/Deploy)       │
      └─────┬────────────┘
            ▼
[Value Plane]
Contribution KPI + Revenue KPI + Priority Rebalance
```

### Plane 상세

- **Interaction Plane**: 사용자 지시/이벤트/크론 트리거 수집
- **Control Plane**: MAIBOT 오케스트레이터(태스크 분해, 라우팅, 우선순위, 승인 판단)
- **Execution Plane**: 프로젝트별 실행 Pod(코드/테스트/배포/운영)
- **Knowledge Plane**: `memory/*.md` + Mnemo GraphRAG + 외부 검색 결합
- **Value Plane**: 기여/수익 KPI를 기반으로 다음 실행 우선순위 자동 조정

---

## 3) 6-Stage 파이프라인 매핑

| Stage       | 목적                  | 핵심 산출물                    | 자동화 수준 |
| ----------- | --------------------- | ------------------------------ | ----------- |
| 1. COLLECT  | 지식/운영 데이터 수집 | 외부지식, 운영로그, 세션요약   | 높음        |
| 2. DISCOVER | 기회 탐지/평가        | 기여-수익 스코어, 시너지 후보  | 중간        |
| 3. CREATE   | 신규 프로젝트 생성    | 템플릿 repo, docs, memory 등록 | 높음        |
| 4. BUILD    | 기능 구현/검증        | 코드, 테스트, 문서, 배포 준비  | 높음        |
| 5. DEPLOY   | 운영 반영             | 릴리스/배포/마이그레이션       | 중간        |
| 6. REALIZE  | 성과 실현/학습        | KPI 리포트, 재우선순위         | 중간        |

---

## 4) 에이전트 토폴로지 (Team Project)

### 4-1. 고정 역할

- **MAIBOT-Orchestrator (메인)**
  - 계획 수립, 정책판단, 승인 게이트, 최종 보고
- **Scout Agent**
  - 시장/기술/경쟁 지식 수집 및 신호 정리
- **Builder Agent**
  - 구현/테스트/리팩토링/문서 동기화
- **Operator Agent**
  - 배포, 모니터링, 장애복구, 런북 실행
- **Auditor Agent**
  - 보안/품질/정책 준수 점검
- **Analyst Agent**
  - 기여/수익 KPI 분석 및 우선순위 제안

### 4-2. 라우팅 정책

- 단순 작업: MAIBOT 직접 실행
- 중간 작업: 서브에이전트 위임 (Sonnet 클래스)
- 복잡 작업: 고성능 에이전트 위임 (Opus 클래스)

---

## 5) 거버넌스/승인 게이트

## 5-1. 승인 없이 자동 실행

- 내부 코드 수정/테스트/문서화
- 내부 분석/리서치/리포팅
- 상태점검/헬스체크/로그 정리

## 5-2. 승인 필수

- 비용 발생 (유료 API 대규모 사용, 클라우드 증설, 결제)
- 외부 발송 (공개 포스트, 대외 메시지, 고객 대량 발송)
- 파괴적 변경 (삭제/롤백/데이터 마이그레이션)
- 공개 배포 (프로덕션/스토어 릴리스)

## 5-3. 품질 게이트

- 테스트 통과 (프로젝트별 기준 충족)
- 문서 동기화 (`docs` + memory)
- 변경 로그/의사결정 로그 기록
- 롤백 절차 존재 확인

---

## 6) 관측성/감사 로깅

- **Run Ledger**: 작업 단위 실행 기록(누가/언제/무엇/결과)
- **Decision Log**: 승인/거절 근거와 정책 판정 기록
- **KPI Store**: 프로젝트별 기여/수익/리스크 지표
- **Incident Log**: 장애 원인/복구 시간/재발 방지책

필수 공통 필드:

- `run_id`, `project`, `stage`, `agent_role`, `risk_level`, `cost_estimate`, `approval_required`, `result`

---

## 7) 데이터 모델(핵심)

### 7-1. Universe Project Registry

- `project_id`, `name`, `repo`, `stage`, `owner_agent`, `health_score`, `contrib_score`, `revenue_score`, `risk_score`

### 7-2. Opportunity Scorecard

- `opportunity_id`, `source`, `project_links[]`, `contribution_impact`, `revenue_impact`, `synergy_score`, `execution_effort`, `priority`

### 7-3. Execution Policy

- `action_type`, `risk_tier`, `auto_allowed`, `requires_approval`, `required_checks[]`

---

## 8) 12주 전환 로드맵 (요약)

### Phase A (1~2주): Foundation

- 정책 매트릭스 확정
- Universe Registry 초안 구축
- 공통 로그 스키마 도입
- Discord 상태 브리핑 템플릿 통합

### Phase B (3~6주): Orchestration

- Stage 1~4 자동 라우팅 안정화
- 프로젝트별 Pod 표준화 템플릿 배포
- 승인 게이트 자동 판정 + 수동 승인 UX 고정

### Phase C (7~9주): Deployment & Reliability

- Stage 5 배포 파이프라인 표준화
- 장애 재시도/롤백/알림 규칙 통일
- 운영 대시보드(헬스, 실패율, 지연) 가시화

### Phase D (10~12주): Realize Engine

- Stage 6 KPI 자동 집계/리밸런싱
- 기여-수익 균형 리포트 자동 생성
- 우선순위 자동 추천(다음 스프린트 백로그)

---

## 9) 즉시 착수 백로그 (2주)

1. `ops/universe/project-registry.yaml` 생성
2. `ops/universe/policy-matrix.yaml` 생성
3. `ops/universe/run-ledger.schema.json` 정의
4. `ops/universe/kpi-metrics.yaml` 정의
5. 주 1회 Universe Architecture Review 리추얼 고정

---

## 10) Definition of Done (v1)

다음을 만족하면 v1 운영 개시:

- [ ] 정책 매트릭스 승인 완료
- [ ] 16개 프로젝트 Registry 등록 완료
- [ ] 공통 실행 로그가 1주 이상 누적
- [ ] 승인 게이트 오탐률/누락률 기준 충족
- [ ] 주간 기여-수익 리포트 자동 발행

---

## 11) 운영 원칙 한 줄

> **"MAIBOT은 프로젝트를 수행하는 에이전트가 아니라, MAI Universe를 경영하는 운영체계다."**
