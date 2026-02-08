# Claude Code Team Operations Manual

## 🦞 OpenClaw Team: Central Operations Guide

**PM (Sujin)** 중심의 중앙 관리형 협업 시스템 및 역할별 도구 가이드.

---

## 1. 팀 구성 및 역할 (R&R)

| 역할 | 이름 | 담당 영역 | 핵심 책임 |
|---|---|---|---|
| **PM/총괄** | **수진** | Board, Roadmap, Sync | 작업 우선순위 결정, 일정 관리, 병목 해결 |
| **Backend** | **하윤** | Core, Gateway, Infra | 시스템 안정성, 빌드/배포 파이프라인, 성능 최적화 |
| **Research** | **민서** | Trend, PoC, Docs | 신기술 조사, 대안 분석, 레퍼런스 확보 |
| **QA/Security** | **예린** | Test, Release, Audit | 품질 보증, 보안 점검, 릴리스 프로세스 관리 |
| **Debug** | **로아** | Logs, Reproduce | 버그 원인 추적, 로그 분석, 시스템 모니터링 |
| **Admin** | **지우** | Archive, Onboarding | 문서화, 지식 관리, 운영 지원, 온보딩 |

---


## 2.5 Persona Compliance (일관성 강제)

- 각 역할 파일 상단의 **Persona**는 “말투/호칭/금지행동/산출물 경로”를 고정한다.
- 페르소나 위반이 감지되면 아래 템플릿으로 즉시 리마인드한다.

**리마인드 템플릿**
> 지금은 **{ROLE}** 역할입니다. {ROLE_BOUNDARY} 밖 작업은 중단하고,  
> 필요한 내용은 **수진(PM)**에게 “요청” 형태로 넘겨주세요.  
> 산출물은 **{OUTPUT_PATH}**에 규격대로 남겨주세요.



## 2. Shared Workspace (`/share`) 운영 규칙

모든 협업 산출물은 프로젝트 루트의 `share/` 디렉토리를 통해 교환합니다.

### 📁 디렉토리 구조
- **`inbox/`**: 요청서, 브리프, 원본 데이터 (PM이 작업 지시서 투하)
- **`outbox/`**: 최종 산출물 (리포트, 코드 패치, 빌드 아티팩트)
- **`logs/`**: 에이전트/스크립트 실행 로그 (자동 생성)
- **`artifacts/`**: 리서치 자료, 스크린샷, 중간 결과물
- **`templates/`**: 표준 보고서/체크리스트 양식

### 🔒 규칙
1. **Naming**: `YYYYMMDD_TaskID_Description.md` (예: `20260208_FixGateway_LogAnalysis.md`)
2. **Locking**: 파일 수정 전 `.lock` 파일 확인 (동시 수정 방지)
3. **Logging**: 모든 스크립트 실행은 `./scripts/run_task.sh` 래퍼 사용 필수.

---

## 3. 역할별 필수 도구 매트릭스 (Tool Matrix)

PM(수진)은 작업 유형에 따라 아래 도구 사용을 **가이드**합니다.

| 작업 유형 | 담당자 | 필수 도구 (Primary) | 보조 도구 (Secondary) | 산출물 위치 |
|---|---|---|---|---|
| **기획/일정** | 수진 | Linear, Notion | Slack, Trello | `share/inbox` |
| **개발/배포** | 하윤 | Docker, Kubernetes, GitHub | SSH, Redis | `share/outbox` |
| **조사/분석** | 민서 | Exa Search, Perplexity | NotebookLM, Playwright | `share/artifacts` |
| **검증/보안** | 예린 | Playwright, SonarQube | Trivy, Vitest | `share/outbox` |
| **디버깅** | 로아 | Chrome DevTools, Axiom | AgentOps, Wireshark | `share/logs` |
| **정리/관리** | 지우 | Filesystem, Obsidian | Calendar, Memory | `docs/` |

---

## 4. 운영 시나리오 (Workflow)

### 상황 A: 새로운 기능 개발 (Feature Dev)
1. **[수진]** Linear 이슈 생성 및 `share/inbox`에 PRD(Notion 요약) 등록.
2. **[민서]** Exa/Perplexity로 기술 조사 → `share/artifacts`에 리포트 저장.
3. **[하윤]** GitHub/Docker 도구로 구현 및 배포 → `share/outbox`에 PR 링크.
4. **[예린]** Playwright/SonarQube로 검증 → 승인 시 머지.
5. **[지우]** `docs/` 업데이트 및 Changelog 반영.

### 상황 B: 긴급 장애 대응 (Hotfix)
1. **[로아]** Axiom/Sentry로 로그 분석 및 원인 파악 → `share/logs`에 리포트.
2. **[하윤]** Docker/SSH로 핫픽스 적용 및 재배포.
3. **[수진]** Slack으로 상황 전파 및 장애 보고서 작성 지시.
4. **[예린]** 사후 검증 및 회귀 테스트.

---

## 5. 터미널 병렬 실행 가이드

효율적인 작업을 위해 터미널 멀티태스킹을 권장합니다.

```bash
# 1. 백그라운드 실행 및 로그 저장
./scripts/run_task.sh task_01 "npm run test" &

# 2. 여러 작업 병렬 실행 (xargs)
cat tasks.txt | xargs -P 4 -I {} ./scripts/run_task.sh {} "process_item {}"

# 3. 리소스 모니터링
watch -n 1 "docker stats --no-stream"

# 4. 로그 실시간 확인 (멀티 테일)
tail -f share/logs/*.log
```

---

## 6. 온보딩 체크리스트 (5분 컷)

- [ ] `scripts/env_check.sh` 실행하여 필수 도구 확인.
- [ ] `openclaw config` 확인 (Gateway 연결).
- [ ] 본인 역할에 맞는 MCP 서버 설정 (`~/.openclaw/mcp.json`).
- [ ] `share/README.md` 정독.
- [ ] 팀원 별 MD 파일(`Desktop/ClaudeCode_Team_Skill_Recommendations/`) 확인.

---

## ⚠️ 자주 터지는 문제 & 대응

1. **Gateway 연결 끊김**: `docker restart openclaw-gateway` 후 `openclaw status` 확인.
2. **A2A 메시지 타임아웃**: Redis MCP로 큐 상태 확인 및 플러시.
3. **MCP 툴 실행 오류**: 샌드박스 로그 확인 및 권한(Allowlist) 점검.
4. **빌드 실패**: `pnpm clean` 후 의존성 재설치 (`pnpm i`).
5. **문서 동기화 실패**: `share/` 폴더 락 파일 확인 및 수동 제거.


## 3.5 Tooling 설치/적재 계획 (중요1)

원칙: **전원 강제 주입 금지**. “카탈로그(가능)”와 “트리거(강제)”를 분리한다.

### 즉시(Top 10) — 이번 주 적용
1) GitHub MCP (PR/Issue/Release 확인용) — Integrator/PM/QA 우선
2) Filesystem MCP — 로그/산출물 수집(Integrator/QA/Debug)
3) Lefthook — 로컬 게이트(린트/테스트) 병렬 실행
4) Commitlint — 커밋 규격 강제(릴리즈 자동화 기반)
5) Release-Please 또는 Semantic-Release(택1) — 릴리즈 PR/태깅 자동화
6) git-cliff — Changelog 초안 생성
7) tmuxp — 병렬 세션 대시보드 템플릿
8) git-machete — 브랜치/스택 정리(Integrator)
9) worktree 표준 스크립트(자동 생성) — 세션별 작업공간 분리
10) pre-merge check 스크립트(자동 생성) — 게이트 자동 실행/로그 표준화

### Backlog(추후) — 팀 상황에 따라
- Slack/Notion/Linear MCP(상태 리포트/아카이브/플래닝 연동)
- Graphite(스택드 PR) 도입(팀 적응 필요)


## 4.5 Merge/Release Gate (중요2)

**Flow:** QA(예린) 승인 → Integrator(지우) Pre-merge/Pre-release Check → PM(수진) 최종 승인  
- Merge/Rebase/Tag/Release 관련 명령은 **지우 세션**에서만 수행한다.
- 예외는 “핫픽스 긴급”이며, 예외 사용 시 outbox에 사유/로그를 남긴다.
