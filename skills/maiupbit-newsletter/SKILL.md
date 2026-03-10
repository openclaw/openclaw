---
name: maiupbit-newsletter
description: "M.AI.UPbit AI Quant Letter 뉴스레터 발행 관리 스킬. 주간 퀀트 데이터 생성, 뉴스레터 초안 확인, Substack 발행 안내, n8n 자동화 파이프라인 상태 확인 및 수정에 사용. 트리거: 뉴스레터 발행, 퀀트 레터, AI Quant Letter, Substack 발행, n8n 뉴스레터, newsletter publish, 주간 레터 초안, 발행 파이프라인 확인."
---

# M.AI.UPbit AI Quant Letter 뉴스레터 스킬

## 핵심 정보

| 항목 | 값 |
|------|-----|
| **Substack** | https://jinilee.substack.com |
| **GitHub repo** | https://github.com/jini92/M.AI.UPbit |
| **초안 폴더** | `C:\TEST\M.AI.UPbit\blog\drafts\` |
| **n8n Cloud** | https://mai-n8n.app.n8n.cloud |
| **n8n 워크플로우 ID** | `tcqab8TejqOgwxMt` (M.AI.UPbit Weekly Newsletter) |
| **n8n 스케줄** | 매주 월요일 00:00 UTC (= 07:00 KST) |
| **GitHub Actions** | `.github/workflows/weekly-report.yml` |

## 파이프라인 구조

```
n8n 스케줄 (월요일 07:00 KST)
    → GitHub Actions workflow_dispatch 트리거
        → 퀀트 데이터 생성 (ci_weekly_report.py)
        → 뉴스레터 초안 생성 (generate_newsletter.py)
        → README 배지 업데이트 (update_readme_badges.py)
        → git push (blog/drafts/ 저장)
        → Discord DM 알림 ("초안 준비됨 → Publish 눌러주세요")
    → 지니님: Substack에서 Publish 클릭 1번
```

## 주요 태스크별 절차

### 1. 수동으로 뉴스레터 지금 발행하기

```powershell
# 퀀트 데이터 생성
cd C:\TEST\M.AI.UPbit
python scripts/ci_weekly_report.py > /tmp/report.json

# 뉴스레터 초안 생성
python scripts/generate_newsletter.py

# 초안 확인
Get-ChildItem blog\drafts\ | Sort-Object LastWriteTime -Descending | Select-Object -First 3
```

초안 파일 확인 후 → https://jinilee.substack.com/publish/posts 에서 발행

### 2. GitHub Actions 수동 트리거

```powershell
gh workflow run weekly-report.yml -R jini92/M.AI.UPbit
gh run list -R jini92/M.AI.UPbit --limit 3
```

### 3. n8n 워크플로우 상태 확인/수정

n8n API Key (MAIBOT, 만료: 2026-04-09):
`memory/2026-03-10.md` 에서 키 조회

```powershell
$key = "<n8n API key>"
# 상태 확인
Invoke-RestMethod -Uri "https://mai-n8n.app.n8n.cloud/api/v1/workflows/tcqab8TejqOgwxMt" `
  -Headers @{"X-N8N-API-KEY"=$key} | Select-Object name, active

# 활성화
Invoke-RestMethod -Uri "https://mai-n8n.app.n8n.cloud/api/v1/workflows/tcqab8TejqOgwxMt/activate" `
  -Headers @{"X-N8N-API-KEY"=$key; "Content-Type"="application/json"} `
  -Method POST -Body "null"
```

### 4. Discord 알림 수동 전송

```powershell
$token = "<DISCORD_BOT_TOKEN>"
$msg = "📬 AI Quant Letter 초안 준비됨! https://jinilee.substack.com/publish/posts"
Invoke-RestMethod -Uri "https://discord.com/api/v10/channels/1466624220632059934/messages" `
  -Headers @{"Authorization"="Bot $token"; "Content-Type"="application/json"} `
  -Method POST -Body (ConvertTo-Json @{content=$msg})
```

## GitHub Secrets (jini92/M.AI.UPbit)

| Secret | 설명 | 상태 |
|--------|------|------|
| `SUBSTACK_SID` | Substack 세션 ID | ✅ |
| `SUBSTACK_URL` | https://jinilee.substack.com | ✅ |
| `SUBSTACK_COOKIE` | substack.lli JWT (브라우저에서 추출) | ✅ |
| `DISCORD_BOT_TOKEN` | MAIBOT Discord Bot Token | ✅ |
| `UPBIT_ACCESS_KEY` | UPbit API 키 (선택) | 미설정 |

## 알려진 제약사항

- **Substack 공식 API 없음** — 비공식 `/api/v1/posts` API는 GitHub Actions에서 403 차단
- **SUBSTACK_COOKIE 만료** — `substack.lli` JWT는 약 30일 만료. 만료 시 브라우저 로그인 후 재추출 필요
- **n8n API Key 만료** — 2026-04-09. 만료 전 `Settings → API → Create an API Key` 에서 재발급

## SUBSTACK_COOKIE 갱신 방법

Substack 쿠키 만료 시:
1. Chrome으로 jinilee.substack.com 로그인
2. DevTools(F12) → Application → Cookies → `substack.lli` 값 복사
3. `gh secret set SUBSTACK_COOKIE --body "substack.lli=<값>" -R jini92/M.AI.UPbit`

자세한 파이프라인 설계: `references/pipeline.md` 참조
