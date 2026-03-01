# MAI Universe 기여 로그

> 기여 이벤트 자동/수동 기록. update-contribution-dashboard.ps1이 GitHub 활동을 자동 수집.
> 수동 추가: 아래 이벤트 로그에 직접 행 추가 후 스크립트 실행.

---

## 기여 점수 기준

| 유형                  | 점수 | 설명                         |
| --------------------- | ---- | ---------------------------- |
| OSS_PR_MERGED         | 10   | 오픈소스 PR 머지             |
| OSS_PR_OPEN           | 3    | 오픈소스 PR 제출 (머지 대기) |
| OSS_ISSUE_FIXED       | 5    | 이슈 해결 (내 PR로)          |
| SKILL_PUBLISHED       | 5    | ClawHub 스킬 배포            |
| BLOG_POST             | 3    | 기술 블로그 포스팅           |
| COMMUNITY_HELP        | 2    | 커뮤니티 질문 답변/도움      |
| GITHUB_STAR_MILESTONE | 1    | 프로젝트 스타 10개 단위      |
| DOCS_CONTRIBUTION     | 2    | 문서 기여                    |

---

## 이벤트 로그

<!-- 형식: | YYYY-MM-DD | 프로젝트 | 유형 | 설명 | 링크 | 점수 | -->

| 날짜       | 프로젝트                     | 유형            | 설명                                                                   | 링크                                                       | 점수 |
| ---------- | ---------------------------- | --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | ---- |
| 2026-03-01 | openclaw/openclaw            | OSS_PR_OPEN     | fix(discord): bare numeric ID → channel default + permanent error 분류 | https://github.com/openclaw/openclaw/pull/30198            | 3    |
| 2026-03-01 | clawhub/expo-appstore-deploy | SKILL_PUBLISHED | Expo App Store Deploy v1.0.1 ClawHub 배포                              | https://clawhub.ai/skills/expo-appstore-deploy             | 5    |
| 2026-03-01 | clawhub/advisory-committee   | SKILL_PUBLISHED | Advisory Committee v1.1.0 ClawHub 배포                                 | https://clawhub.ai/skills/advisory-committee               | 5    |
| 2026-02-25 | obsidianmd/obsidian-releases | OSS_PR_OPEN     | Mnemo 플러그인 PR #10406 재제출                                        | https://github.com/obsidianmd/obsidian-releases/pull/10406 | 3    |

---

## 월별 누적 (스크립트가 자동 갱신)

| 월      | 기여 건수 | 누적 점수 | 주요 기여                    |
| ------- | --------- | --------- | ---------------------------- |
| 2026-02 | 1         | 3         | Obsidian 플러그인 PR         |
| 2026-03 | 1         | 3         | openclaw Discord 버그픽스 PR |

---

## 추적 대상 레포 (스크립트 자동 조회)

- openclaw/openclaw
- obsidianmd/obsidian-releases
- jini92/MAISECONDBRAIN
- jini92/MAIOSS
- jini92/MAIBOTALKS
- jini92/MAITOK
- jini92/MAITUTOR
- jini92/MAICON
