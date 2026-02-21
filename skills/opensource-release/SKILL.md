---
name: opensource-release
description: Convert a private MAI project repository to public open-source. Use when making a repo public, sanitizing personal info from code/docs/git history, or preparing a project for open-source release. Triggers on "오픈소스", "public 전환", "공개", "open source release".
---

# Open Source Release

Private repo를 public으로 안전하게 전환하는 스킬.

## Pre-flight Checklist

1. **개인정보 스캔** — 모든 소스/문서에서 아래 패턴 검색:
   - 로컬 경로: `C:\Users\{username}\`, 홈 디렉토리 경로
   - 사용자명: Windows/macOS 로컬 계정명
   - 볼트/폴더명: 개인 식별 가능한 이름 (JINI_SYNC 등)
   - API 키/토큰: `.env`, 하드코딩된 시크릿
   - 이메일/전화번호: 커밋 author 포함

2. **캐시/빌드 산출물 확인** — `.gitignore`에 포함 여부:
   - 바이너리 캐시 (`.pkl`, `.db`, `checksums.json`)
   - `__pycache__/`, `node_modules/`, `.env`, `*.egg-info/`
   - 프로젝트 특화 캐시 디렉토리

## Sanitization Steps

### Step 1: 코드 정리

```
검색 명령:
  Get-ChildItem -Recurse -Include "*.py","*.ps1","*.js","*.ts" |
    Select-String -Pattern "C:\\Users|/home/|JINI_SYNC|jini9" -SimpleMatch |
    Where-Object { $_.Path -notmatch "__pycache__|node_modules|\.git" }

치환 방식:
  - 하드코딩 경로 → 환경변수 (os.environ.get / process.env)
  - config.example.yaml 또는 .env.example 생성
  - 각 스크립트에 환경변수 미설정 시 에러 메시지 추가
```

### Step 2: 문서 정리

```
검색 명령:
  Get-ChildItem -Recurse -Include "*.md","*.txt","*.yaml","*.yml" |
    Select-String -Pattern "C:\\Users|/home/|jini9|JINI_SYNC" -SimpleMatch |
    Where-Object { $_.Path -notmatch "node_modules|\.git" }

치환 규칙:
  - 로컬 경로 → 플레이스홀더 ($VAULT_PATH, ~/vault 등)
  - 개인 사용자명 → your-username 또는 제거
  - GitHub 사용자명 → 유지 가능 (이미 public)
  - README에 환경변수 설정 가이드 추가
```

### Step 3: Git History 분석

```
분석 명령:
  git log --all -p | Select-String -Pattern "개인정보패턴" | Select-Object -First 50
  git log --all --diff-filter=A -- "캐시경로/*"

판단 기준:
  - 커밋 수 < 50 + 캐시/시크릿이 history에 존재 → Option B (clean push)
  - 커밋 수 많고 history 중요 → Option A (BFG/filter-repo)
  - history에 민감 정보 없음 → Option C (그냥 진행)
```

### Step 4: Clean Push (Option B 선택 시)

```powershell
git checkout --orphan clean-main
git add -A
git commit -m "feat: initial public release - [프로젝트 설명]"
git remote set-url origin https://github.com/{owner}/{repo}.git  # 토큰 제거!
git branch -M main
git push origin main --force
# 기존 브랜치 삭제
git push origin --delete {old-branch}
```

### Step 5: Public 전환

```powershell
gh repo edit {owner}/{repo} --visibility public --accept-visibility-change-consequences --description "설명"
```

### Step 6: 검증

```powershell
# 개인정보 최종 스캔
Get-ChildItem -Recurse -Include "*.py","*.md","*.yaml","*.js","*.ts" |
  Select-String -Pattern "개인정보패턴" -SimpleMatch |
  Where-Object { $_.Path -notmatch "__pycache__|node_modules|\.git|\.mnemo" }

# Remote URL에 토큰 없는지 확인
git remote -v

# Public 확인
gh repo view {owner}/{repo} --json visibility
```

### Step 7: 이슈 자동 대응 설정 (선택)

- HEARTBEAT.md에 Active Tracking 추가
- github-issue-watcher.ps1에 repo 추가 (또는 별도 watcher)
- memory/{project}.md에 이슈 추적 상태 기록

## 주의사항

- **git remote URL에 토큰이 박혀있을 수 있음** — 반드시 확인/제거
- **바이너리 캐시**는 .gitignore만으로 부족 — history에 이미 있을 수 있음
- **한글 인코딩** — PowerShell/Python에서 한글 폴더명 깨짐 주의
- GitHub 사용자명(jini92)은 public이므로 유지 OK
- `.env` 파일은 절대 커밋하지 않음
