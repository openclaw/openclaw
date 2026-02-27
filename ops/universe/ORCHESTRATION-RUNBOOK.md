# MAI Universe Orchestration Runbook

- Version: v1.0
- Updated: 2026-02-26 (KST)
- Owner: MAIBOT-Orchestrator
- Scope: MAI Universe 일일/주간 운영, 장애 대응, Discord DM 브리핑 표준화

---

## 0) 운영 원칙 (현재 환경 재사용)

이 런북은 아래 **기존 운영 자산**을 그대로 활용한다.

1. **Cron 스케줄러**: 정기 실행(일간/주간 루틴 자동화)
2. **Memory 체계**: `MEMORY.md`, `memory/YYYY-MM-DD.md` 기록
3. **프로젝트별 repo 운영**: `ops/universe/project-registry.yaml` 기준
4. **Discord DM 보고**: 외부/요약 보고는 DM 채널 중심

> 정책 기준은 `ops/universe/policy-matrix.yaml`을 단일 기준(Source of Truth)으로 사용한다.

---

## 1) 운영 데이터 기준 파일 (SoT)

- 프로젝트 레지스트리: `ops/universe/project-registry.yaml`
- 정책 매트릭스: `ops/universe/policy-matrix.yaml`
- KPI 메트릭 정의: `ops/universe/kpi-metrics.yaml`
- 실행 로그 스키마: `ops/universe/run-ledger.schema.json`

### 1.1 로그/기록 규칙

- 실행 단위 로그: Run Ledger(JSONL 권장)
  - 필수 필드: `run_id`, `timestamp`, `project`, `stage`, `agent_role`, `risk_level`, `approval_required`, `result`
- 당일 운영 노트: `memory/YYYY-MM-DD.md`
- 장기 정책/결정사항: `MEMORY.md`

---

## 2) 일간 루틴 (Daily Routine)

## 2.1 오전 프리플라이트 (권장: 08:30 KST)

1. 게이트웨이/채널 상태 확인
   - `openclaw channels status --probe`
2. Cron 상태 확인
   - `openclaw cron status`
   - `openclaw cron list`
3. Memory 인덱스/상태 확인 (필요 시)
   - `openclaw memory status`
4. 전일 실패 작업 확인
   - `openclaw cron runs --id <jobId> --limit 20`
   - 실패 건 있으면 4장(장애 대응) 절차로 전환

## 2.2 프로젝트 헬스 스윕 (권장: 09:00~10:00)

`project-registry.yaml`의 각 프로젝트에 대해 아래를 수행한다.

- 레포 최신화 상태 확인 (최근 커밋/PR/이슈 흐름)
- 건강지표 점검 (`health_score`, `risk_score` 변화)
- Stage 정합성 확인 (`COLLECT~REALIZE`)
- 이슈 분류:
  - 정상(추적만)
  - 주의(당일 액션 필요)
  - 장애(즉시 복구/에스컬레이션)

결과는 아래 2곳에 기록:

1. Run Ledger
2. `memory/YYYY-MM-DD.md` (요약 + 판단 근거)

## 2.3 일일 브리핑 발송 (권장: 10:30)

- 대상: Discord **DM**
- 내용: 오늘의 우선순위, 위험요인, 승인 필요 항목
- 템플릿: 5장 `일일 브리핑 템플릿` 사용

## 2.4 마감 루틴 (권장: 18:00)

- 당일 실행 결과를 `success/partial/failed/blocked`로 정리
- 실패/지연 건은 다음날 첫 슬롯으로 예약
- `memory/YYYY-MM-DD.md`에 아래 3줄 필수 기록
  1. 오늘 완료
  2. 미완료/장애
  3. 내일 첫 액션

---

## 3) 주간 루틴 (Weekly Routine)

## 3.1 주간 리밸런싱 (권장: 월요일 09:30)

1. KPI 점검 (기여/수익/운영/전략)
   - 기준: `ops/universe/kpi-metrics.yaml`
2. 프로젝트 우선순위 재조정
   - `contrib_score` vs `revenue_score` 균형
   - `risk_score` 높은 항목 선제 완화
3. Stage 이동 검토
   - BUILD → DEPLOY
   - DEPLOY → REALIZE

산출물:

- 주간 우선순위 Top N
- 승인 필요 액션 목록
- 리스크 완화 액션 목록

## 3.2 거버넌스 감사 (권장: 수요일)

- `policy-matrix.yaml` 위반/우회 시도 점검
- 고위험 액션의 승인 이력 검증
- 누락 로그/누락 메모리 보완

## 3.3 주간 성과 브리핑 (권장: 금요일 17:00)

- 대상: Discord DM
- 내용:
  - 주간 성과(기여/수익)
  - 실패/장애 및 MTTR
  - 다음 주 핵심 실행 3개
- 템플릿: 5장 `주간 브리핑 템플릿`

---

## 4) 장애 대응 Runbook (실패 재시도/에스컬레이션)

## 4.1 장애 등급

- **SEV-1 (Critical)**: 배포 중단, 데이터 손상 위험, 대외 영향 큼
- **SEV-2 (High)**: 핵심 자동화 실패, 다수 프로젝트 진행 차질
- **SEV-3 (Medium)**: 단일 프로젝트/단일 작업 실패
- **SEV-4 (Low)**: 일시적/비핵심 실패

## 4.2 1차 대응 (T+0 ~ T+15m)

1. 실패 유형 분류
   - 일시적(네트워크/429/타임아웃)
   - 정책 차단(승인 미충족)
   - 인증/권한 실패
   - 코드/테스트 실패
2. 영향 범위 확인
   - 프로젝트 단일/복수
   - Stage 영향(COLLECT~REALIZE)
3. 즉시 알림
   - SEV-1/2는 즉시 DM 알림 발송 (템플릿 사용)

## 4.3 재시도 정책

| 실패 유형            | 재시도 | 간격                          | 최대 횟수 | 비고                       |
| -------------------- | -----: | ----------------------------- | --------: | -------------------------- |
| 네트워크/타임아웃    |   자동 | 1m → 5m → 15m                 |         3 | 지수 백오프                |
| 429/일시적 제한      |   자동 | `retry_after` 우선, 없으면 3m |         3 | 호출량 축소 병행           |
| 테스트 실패          | 조건부 | 수정 후 재실행                |         2 | 동일 실패 반복 시 원인분석 |
| 인증/권한 실패       |   수동 | 즉시 중단                     |       0~1 | 자격증명/권한 점검 후 1회  |
| 정책 차단(승인 필요) |   불가 | -                             |         0 | 승인 요청으로 전환         |

## 4.4 에스컬레이션 기준

- 즉시 에스컬레이션:
  - SEV-1
  - 동일 장애 3회 반복
  - 승인 필요 액션이 24시간 이상 대기
- 단계별:
  - **L1 (Operator)**: 재시도/임시조치
  - **L2 (Orchestrator)**: 우선순위 재조정, 대체 플랜 실행
  - **L3 (Owner 승인)**: 고위험/비용/외부발신/파괴적 변경 승인

## 4.5 복구 완료 후

필수 3종 기록:

1. Incident 요약 (원인/조치/복구시간)
2. Run Ledger 결과 업데이트 (`failed` → `partial/success` 등)
3. `memory/YYYY-MM-DD.md`에 재발 방지 액션 등록

---

## 5) Discord 브리핑 템플릿

> 기본 원칙: 운영 보고는 Discord **DM 우선**. (채널 브로드캐스트는 승인 후)

## 5.1 일일 브리핑 템플릿

```markdown
[MAI Universe Daily Brief | YYYY-MM-DD]

1. 오늘의 상태

- 전체: 정상 / 주의 / 장애
- 핵심 프로젝트: <프로젝트명, stage, health>

2. 오늘 완료

- [완료] <작업 1>
- [완료] <작업 2>

3. 리스크/이슈

- [SEV-?] <이슈 요약> / 영향: <범위>
- 조치: <진행상태>

4. 승인 필요 항목

- <액션> / 사유: <policy 기준>

5. 내일 첫 액션

- <우선순위 1>
```

## 5.2 주간 브리핑 템플릿

```markdown
[MAI Universe Weekly Brief | YYYY-Www]

1. 주간 요약

- Contribution: <요약>
- Revenue: <요약>
- Operations: <배포성공률, MTTR, 장애건수>

2. Top 성과

- <성과 1>
- <성과 2>

3. 실패/장애 회고

- <이슈> / 원인: <원인> / 재발방지: <액션>

4. 우선순위 리밸런싱

- 상승: <프로젝트/이유>
- 하향: <프로젝트/이유>

5. 다음 주 핵심 3개

- <실행 1>
- <실행 2>
- <실행 3>
```

## 5.3 장애 알림 템플릿 (즉시)

```markdown
[INCIDENT][SEV-?] <제목>

- 발생시각: <YYYY-MM-DD HH:mm KST>
- 영향범위: <프로젝트/기능/사용자>
- 현재상태: 대응중 / 복구완료 / 모니터링중
- 1차조치: <조치 내용>
- 다음업데이트: <HH:mm>
```

## 5.4 장애 종료 템플릿

```markdown
[RESOLVED][SEV-?] <제목>

- 발생~복구: <xx분>
- 근본원인: <원인>
- 복구조치: <조치>
- 재발방지: <액션 + 일정 + 담당>
```

---

## 6) 권장 Cron 베이스라인

아래 잡은 예시이며, 기존 잡과 충돌 시 **기존 ID 유지 + 메시지만 보정**한다.

```bash
openclaw cron add --name "universe-daily-preflight" --cron "30 8 * * *" --session isolated --message "Run MAI Universe daily preflight and log results." --announce --channel discord --to "user:1466624220632059934"

openclaw cron add --name "universe-daily-brief" --cron "30 10 * * *" --session isolated --message "Generate and send Daily Brief in template format." --announce --channel discord --to "user:1466624220632059934"

openclaw cron add --name "universe-weekly-review" --cron "0 17 * * 5" --session isolated --message "Generate Weekly Brief + next week top priorities." --announce --channel discord --to "user:1466624220632059934"
```

---

## 7) 운영 체크리스트 (요약)

### Daily

- [ ] 프리플라이트 완료 (채널/cron/memory)
- [ ] 프로젝트 스윕 완료
- [ ] DM 일일 브리핑 발송
- [ ] memory + run ledger 기록 완료

### Weekly

- [ ] KPI 기반 리밸런싱 완료
- [ ] 정책/승인 감사 완료
- [ ] DM 주간 브리핑 발송
- [ ] 장애 재발방지 항목 업데이트

---

## 8) 의사결정 우선순위

1. 안전/정책 준수
2. 장애 복구와 서비스 연속성
3. 기여-수익 균형 최적화
4. 자동화 확대(수동 반복 제거)

> 원칙: **자동화는 기본, 고위험 액션은 승인 기반**.
