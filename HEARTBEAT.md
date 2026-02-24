# HEARTBEAT.md - Periodic Maintenance Tasks

## Purpose

하트비트 체크 시 실행할 작업. 가이드가 아닌 **실행 항목**.

## ⚠️ 중복 방지 규칙

- **Daily/Weekly/Monthly 크론 작업은 크론 스케줄러가 정해진 시각에 1회 트리거한다.**
- **하트비트에서는 크론 작업을 직접 실행하지 않는다.** 하트비트는 "Every Heartbeat" 섹션만 수행.
- 하트비트 역할: Active Tracking (이슈 추적 등 상태 변화 감지) + 이상 징후 알림만.

---

## Every Heartbeat (매시간)

### Active Tracking

#### Obsidian 커뮤니티 플러그인 PR #10406 (재제출)

- **URL:** https://github.com/obsidianmd/obsidian-releases/pull/10406
- **상태:** Open, 자동검증 봇 결과 대기
- **이전 PR:** #10404 — 유니코드 깨짐 + 9회 검증 실패로 닫음
- **체크:** `gh pr view 10406 -R obsidianmd/obsidian-releases --json state,reviews,comments`
- **할 일:**
  1. 리뷰 코멘트 달리면 → 내용 분석 → 코드 수정 → push → 답변
  2. 변경 요청 시 → 수정 후 re-request review
  3. 진행 상황 Discord DM 보고
- **완료 조건:** PR 머지됨

#### MAIBOTALKS App Store 심사 추적

- **URL:** https://appstoreconnect.apple.com/apps/6759508239/appstore/ios/version/inflight
- **상태:** 심사 대기 중 (2026-02-22 제출, 메타데이터 2026-02-24 수정 완료)
- **체크:** `curl -s "https://botalks.app/" -o /dev/null -w "%{http_code}"` (사이트 정상 여부)
- **할 일:**
  1. 심사 결과 나오면 → Discord DM 즉시 보고
  2. 승인 시 → 출시 준비 (ASC 인앱 구독 상품 생성 필요)
  3. 거부 시 → 사유 분석 → 수정 계획 수립 → Discord DM 보고
- **완료 조건:** App Store 출시 완료 또는 거부 대응 완료

#### MAISECONDBRAIN (Mnemo) — 이슈 자동 대응

- **Repo:** https://github.com/jini92/MAISECONDBRAIN
- **체크:** `gh issue list -R jini92/MAISECONDBRAIN --state open --json number,title,createdAt,labels,author`
- **할 일:**
  1. 새 이슈 발견 시 → 내용 분석 (버그/기능요청/질문 분류)
  2. 버그: 재현 가능하면 직접 수정 + PR/커밋 + 이슈에 코멘트
  3. 기능요청: 타당성 분석 → Discord DM 보고 + 의견 제시
  4. 질문: 답변 코멘트 작성
  5. 대응 결과를 Discord DM으로 지니님께 보고
- **기록:** 마지막 체크한 이슈 번호를 `memory/maisecondbrain.md`에 기록하여 중복 처리 방지

---

## Weekly (크론으로 실행)

### 🎯 주간 기회 리뷰 (매주 월요일 07:30 KST)

- Mnemo 지식그래프 + 외부 지식에서 기회 자동 탐지
- 기존 16개 프로젝트 기여-수익 스코어링 갱신
- 황금지대(🟢) 기회 발견 시 Discord DM 브리핑
- Stage 이동 필요 프로젝트 식별 (BUILD → DEPLOY 등)
- Obsidian 리포트: `{날짜}_Weekly_Opportunity_Review.md`

---

## Daily (크론으로 실행)

### AI 수익화 브리핑 (매일 03:00 KST)

- 최신 AI 수익화 트렌드, 디스커버리/프로프리에터리 수익 분석, AI SaaS 시장 동향 조사
- Obsidian 노트 + Discord DM 보고

### AI 기술 브리핑 (매일 03:05 KST)

- 최신 AI 기술 뉴스, X(트위터) 토론, 주요 모델 출시/업데이트, 빅테크 동향
- Obsidian 노트 + Discord DM 보고

### MAIBOT 업데이트 체크 (매일 03:10 KST)

- upstream fetch + 주요 변경사항 요약 + pnpm audit 보안 점검
- Obsidian 노트 + Discord DM 보고

### 🔬 테크 인텔리전스 (매일 04:00 KST)

- 각 프로젝트 기술 스택 관련 최신 동향 리서치
- 적용 가능한 인사이트 → 해당 프로젝트 memory에 기록
- Obsidian 노트 + Discord DM 보고

### 💼 사업화 인텔리전스 (매일 04:30 KST)

- 각 프로젝트 사업 시장 관련 최신 동향 리서치
- 경쟁사/신규 서비스 동향 + 수익화 기회 발견
- Obsidian 노트 + Discord DM 보고

### 💊 약 리마인더 (매일 05:30 KST)

- 고혈압약 복용 알림

### 🧠 Mnemo 볼트 보강 + 기회 탐지 (매일 05:00 KST)

- `cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"; python scripts/daily_enrich.py`
- 10단계 파이프라인: 파싱 → 보강(type/project/related/태그/백링크) → 그래프 재빌드 → 스텁 → 임베딩 → 외부 지식 수집 → 대시보드 싱크 → **기회 스캔**
- 기회 스캔: 외부 지식에서 기여-수익 매트릭스 자동 스코어링 → Obsidian 리포트 저장
- **이슈 있을 때만 알림**

### 🌅 모닝 브리핑 (매일 06:00 KST)

- 전체 프로젝트 git status 확인
- GitHub 추적 이슈 새 댓글 확인
- 오늘 요일 기준 주간 작업 실행
- 우선순위 작업 정리 → Discord DM 보고

### 🔍 오후 순찰 (매일 12:00 KST)

- GitHub 이슈 추적
- 각 프로젝트 git status
- MAIBOT 빌드 확인
- 임시 파일 정리
- **이슈 있을 때만 알림** (정상이면 조용히)

---

### 📊 주간 리뷰 (매주 월요일 07:00 KST)

- MEMORY.md 전체 프로젝트 진행 점검
- 각 프로젝트 최근 커밋 (7일)
- \_MASTER_DASHBOARD.md 업데이트
- KPI 대시보드 갱신 (kpi-collector.ps1 → \_KPI_DASHBOARD.md)
- pnpm test:coverage (MAIBOT, ≥70% threshold)
- pnpm audit (보안)
- 주간 종합 리포트 → Discord DM

### Wednesday: Dependency Health

- pnpm audit → 보안 취약점 확인
- pnpm outdated → 중요 업데이트 확인

### Friday: Documentation Sync

- docs/ 변경사항 확인
- CHANGELOG.md 업데이트 필요 여부

---

## Monthly (First Monday)

- Full test suite
- .secrets.baseline 확인
- 700 LOC 초과 파일 확인
- skills/ 폴더 패턴 점검

---

## Conditional Tasks

### On Error Patterns

- **Repeated Errors** (3+ occurrences): 근본 원인 조사
- **Test Flakiness**: 안정화 또는 known flake 문서화
- **Build Time Increase** (>20%): 프로파일링

### On New Channel Integration

- docs/channels/ 업데이트
- .github/labeler.yml 업데이트
- AGENTS.md 문서화

---

## Implementation Note

**실행 우선.** 판단이 애매한 작업은 스킵해도 됨. 목표는 건강 유지, 관료주의가 아님.

**EXFOLIATE!** — 가치 없는 작업은 이 파일에서 제거하라.

---

_Last reviewed: 2026-02-24_
