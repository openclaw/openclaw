---
name: mai-contribution-tracker
description: MAI Universe 기여 & 수익화 이벤트를 기록하고 Obsidian 대시보드를 자동 업데이트한다. 트리거: (1) 오픈소스 PR 제출/머지, (2) 스킬 배포, (3) 앱 매출/MRR 발생, (4) "기여 기록해줘", "수익 등록해줘", "대시보드 업데이트", "contribution log", "PR merged", "revenue update". NOT for: 단순 프로젝트 상태 조회 → memory_search 사용.
---

# MAI Contribution Tracker

MAI Universe 철학 — **기여할수록 강해지고, 수익화할수록 지속된다** — 를 수치로 추적하고 Obsidian 대시보드에 자동 반영한다.

## 데이터 파일

| 파일                                                  | 역할                         |
| ----------------------------------------------------- | ---------------------------- |
| `C:\MAIBOT\memory\contributions.md`                   | 기여 이벤트 로그 (자동+수동) |
| `C:\MAIBOT\memory\revenue-tracker.md`                 | 수익화 이벤트 로그           |
| `C:\MAIBOT\scripts\update-contribution-dashboard.ps1` | 대시보드 갱신 스크립트       |

## 대시보드 파일 (Obsidian)

| 파일                                                        | 내용                                 |
| ----------------------------------------------------------- | ------------------------------------ |
| `JINI_SYNC\01.PROJECT\00.MAIBOT\_CONTRIBUTION_DASHBOARD.md` | 전체 상세 대시보드                   |
| `JINI_SYNC\TEMPLATES\Dashboard.md`                          | 메인 대시보드 맨 위 싱크 (AUTO 블록) |

---

## 워크플로우

### A. 기여 이벤트 발생 시

1. **이벤트 분류** (아래 점수표 참고)
2. **contributions.md 이벤트 로그에 행 추가**:
   ```
   | YYYY-MM-DD | 레포/프로젝트 | 유형 | 설명 | URL | 점수 |
   ```
3. **대시보드 갱신 스크립트 실행**:
   ```powershell
   powershell -File C:\MAIBOT\scripts\update-contribution-dashboard.ps1
   ```
4. Discord DM으로 결과 보고

### B. 수익화 이벤트 발생 시

1. **revenue-tracker.md 월별 테이블 업데이트** (해당 프로젝트 + 월 행)
2. **대시보드 갱신 스크립트 실행** (위와 동일)
3. Discord DM으로 결과 보고

### C. PR 머지 확인 (GitHub 자동 감지)

스크립트가 GitHub API를 자동 조회해서 PR 상태(OPEN→MERGED) 변경을 감지하고 점수를 갱신한다. 수동 트리거 없이 heartbeat(매일 06:05)에서 자동 실행된다.

---

## 기여 점수표

| 유형 코드               | 점수 | 예시                         |
| ----------------------- | ---- | ---------------------------- |
| `OSS_PR_MERGED`         | 10   | openclaw PR #30198 머지      |
| `OSS_PR_OPEN`           | 3    | PR 제출 (머지 대기)          |
| `OSS_ISSUE_FIXED`       | 5    | 이슈 수정 커밋               |
| `SKILL_PUBLISHED`       | 5    | ClawHub 스킬 배포            |
| `BLOG_POST`             | 3    | 기술 블로그 포스팅           |
| `COMMUNITY_HELP`        | 2    | Discord/GitHub 커뮤니티 기여 |
| `DOCS_CONTRIBUTION`     | 2    | 문서 PR                      |
| `GITHUB_STAR_MILESTONE` | 1    | 프로젝트 스타 10개 단위      |

---

## 수동 기여 등록 예시

지니님이 "openclaw PR 머지됐어" 라고 하면:

```markdown
<!-- memory/contributions.md 이벤트 로그에 추가 -->

| 2026-03-05 | openclaw/openclaw | OSS_PR_MERGED | fix(discord): bare ID default | https://github.com/openclaw/openclaw/pull/30198 | 10 |
```

그 후 스크립트 실행 → 대시보드 자동 갱신.

---

## 수익화 등록 예시

지니님이 "MAIBOTALKS 앱 첫 구독 발생, 3,900원" 이라고 하면:

`revenue-tracker.md` 월별 테이블에서 해당 월/프로젝트 셀 업데이트:

```markdown
| 2026-03 | 3900 | 0 | 0 | 0 | 0 |
```

그 후 스크립트 실행.

---

## 스크립트 참고

- 상세 로직: `scripts/update-contribution-dashboard.ps1`
- 추적 레포 목록 수정: 스크립트 내 `$trackedRepos` 배열
- GitHub PR 자동 수집: `gh pr list --author jini92` (gh CLI 인증 필요)
