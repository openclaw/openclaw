# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.

---

## MAIBOT-Specific Tools

### Development Commands

**Full Build**:

```bash
pnpm build  # TypeScript compile + canvas bundle + metadata copy
```

**Development Run**:

```bash
pnpm dev  # or: pnpm moltbot
```

**Gateway Development**:

```bash
pnpm gateway:dev  # with CLAWDBOT_SKIP_CHANNELS=1
```

### Testing

**Quick Test**:

```bash
pnpm test
```

**Coverage Check**:

```bash
pnpm test:coverage  # 70% threshold enforced
```

**Live Tests** (requires credentials):

```bash
CLAWDBOT_LIVE_TEST=1 pnpm test:live
```

**Docker E2E**:

```bash
pnpm test:docker:all
```

### Useful Shortcuts

**Pre-commit Validation**:

```bash
prek install && pnpm build && pnpm test
```

**Gateway Restart** (production via SSH):

```bash
pkill -9 -f moltbot-gateway || true; \
nohup moltbot gateway run --bind loopback --port 18789 --force \
> /tmp/moltbot-gateway.log 2>&1 &
```

**Gateway Status Check**:

```bash
moltbot channels status --probe
ss -ltnp | rg 18789
tail -n 120 /tmp/moltbot-gateway.log
```

### MCP Servers (from .mcp.json)

- **Playwright**: Browser automation for testing
- **Fetcher**: Web content retrieval (Readability algorithm)
- **Context7**: Real-time library documentation
- **Magic**: UI component generation (Magic UI design system)

### Environment

- **Node Version**: ≥22.12.0 (required)
- **Package Manager**: pnpm@10.23.0 (primary)
- **Alternative Runtime**: bun (for TypeScript execution)
- **Timezone**: Asia/Seoul (GMT+9) — matches 지니's timezone

---

### 🔧 개발 방식: MAIBOT 직접 구현 (2026-02-07 변경)

**모든 프로젝트에 적용** — 지니님 지시

```
지니님 (Discord)
    ↓ 지시/브레인스토밍
MAIBOT (직접 구현)
    ├── 코드 읽기/쓰기/편집 (Read/Write/Edit 도구)
    ├── 셸 명령 실행 (exec)
    ├── git 커밋/푸시
    ├── 문서화
    └── Discord 알림
```

**MAIBOT이 전부 직접 처리:**
| 역할 | MAIBOT |
|------|--------|
| 지시 수신 (Discord) | ✅ |
| 요구사항 분석 | ✅ |
| **코딩/디버깅** | ✅ 직접 |
| **대규모 리팩토링** | ✅ 직접 |
| **테스트** | ✅ 직접 |
| 문서화 | ✅ |
| git 커밋/푸시 | ✅ |
| Discord 노티 | ✅ |
| 메모리 관리 | ✅ |

**이전 방식 (폐기):** 하이브리드 (MAIBOT + Claude Code CLI)

- 2026-02-06 도입 → 2026-02-07 폐기
- 폐기 사유: Claude Code CLI의 MCP 서버/plugins 로딩 충돌로 hang 발생
- .claude/agents/, .mcp.json, CLAUDE.md 파일은 프로젝트에 남아있음 (향후 재활용 가능)

---

### MAIBEAUTY 개발 환경

**프로젝트:** 베트남 화장품 사업 (BnF AI Sales Automation)

```
- 로컬: C:\TEST\MAIBEAUTY
- GitHub: https://github.com/jini92/MAIBEAUTY
- 개발 도구: Claude Code
- 플로우: Claude Code (워크스페이스: C:\TEST\MAIBEAUTY) → 커밋 → git push
```

**Claude Code 실행:**

```bash
# 단발 작업
claude 'task description' (workdir: C:\TEST\MAIBEAUTY)

# 백그라운드 장기 작업
claude 'task' (background + pty)
```

**개발 후 push:**

```bash
cd C:\TEST\MAIBEAUTY
git add -A
git commit -m "feat: description"
git push origin main
```

---

### Google Cloud SDK

**Path**: `C:\Users\jini9\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`
**Version**: 554.0.0
**On User PATH**: Yes

```bash
# Refresh PATH in current session
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

# Verify
gcloud --version

# Auth login (opens browser)
gcloud auth login

# Set project
gcloud config set project <PROJECT_ID>

# Enable Sheets API
gcloud services enable sheets.googleapis.com

# Create service account
gcloud iam service-accounts create maibeauty-crm --display-name="MAIBEAUTY CRM"
```

---

### MAIBEAUTY 서비스 접근 정보

모든 키/토큰은 `C:\TEST\MAIBEAUTY\.env`에 저장 (git 무시됨).

| 서비스             | 접근 방법               | .env 키                                                                                     |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------- |
| **MAIBEAUTY API**  | REST API (JWT 인증)     | `MAIBEAUTY_API_URL`, `MAIBEAUTY_ADMIN_EMAIL`, `MAIBEAUTY_ADMIN_PASSWORD`                    |
| **Cloudflare R2**  | boto3 S3 호환           | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_PUBLIC_URL` |
| **Cloudflare API** | REST API (Bearer Token) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                                             |
| **Video Worker**   | Worker key 인증         | `VIDEO_WORKER_KEY`                                                                          |
| **Railway**        | CLI 로그인 상태         | `railway variables` (MAIBEAUTY 프로젝트)                                                    |
| **GitHub**         | git credential 저장     | `jini92/MAIBEAUTY`, `jini92/MAIBOT`                                                         |
| **Ollama**         | 로컬 LLM                | `OLLAMA_BASE_URL` (localhost:11434)                                                         |
| **Google Sheets**  | Service Account JSON    | `GOOGLE_SERVICE_ACCOUNT_JSON`, `CRM_SPREADSHEET_ID`                                         |

**자주 쓰는 명령:**

```powershell
# API 로그인 (토큰 발급)
$login = Invoke-RestMethod -Uri "$env:MAIBEAUTY_API_URL/api/v1/auth/login" -Method POST -ContentType "application/json" -Body '{"email":"jini@maibeauty.vn","password":"BnF@2026!Admin"}'
$token = $login.access_token

# 영상 생성 Job 제출
Invoke-RestMethod -Uri "$env:MAIBEAUTY_API_URL/api/v1/products/{product_id}/ai/generate-video" -Method POST -Headers @{"Authorization"="Bearer $token";"Content-Type"="application/json"} -Body '{"language":"vi","style":"tiktok_short","duration_target":60}'

# Worker 시작
cd C:\TEST\MAIBEAUTY; python src/workers/video_worker.py --api-url https://maibeauty-api-production.up.railway.app --worker-key 0aP87uilc4OH93kTwjYbXpNnhBgrQx6e

# Cloudflare R2 버킷 조회
$headers = @{ "Authorization" = "Bearer $env:CLOUDFLARE_API_TOKEN" }
Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$env:CLOUDFLARE_ACCOUNT_ID/r2/buckets/maibeauty-media" -Headers $headers
```

### Discord 노티 규칙

- **절대 금지**: `#일반` 채널(1466615738512179394)에 메시지 전송 금지 (보안 위험)
- **DM 전용**: 지니님 DM 채널(1466624220632059934)으로만 전송
- **민감 정보 제거**: 규정 문서 번호, 내부 시스템명, 제어기 정보 등 비공개 정보 포함 금지

### Obsidian 볼트

- **경로:** `C:\Users\jini9\OneDrive\Documents\JINI_SYNC`
- **구조:** PARA 기반
- **CLI:** obsidian-cli 미지원 (Windows) → 직접 파일 읽기/쓰기로 연동
- **동기화:** OneDrive → 아이패드 Obsidian (풀 기능) 실시간 반영
- **아이패드:** Obsidian 풀 기능 사용 중 (편집/확인 가능)

**폴더 구조:**

```
JINI_SYNC/
├── 00.DAILY/          ← 데일리 노트, 브리핑
├── 01.PROJECT/        ← 프로젝트별 폴더 (★ 프로젝트 문서는 여기)
│   ├── 00.MAIBOT
│   ├── 01.MAITCAD
│   ├── 02.MAIPnID
│   ├── 03.MAIAX
│   ├── 04.MAIOSS
│   ├── 05.MAITB
│   ├── 06.MAITHINK
│   ├── 07.MAIBEAUTY
│   ├── 08.MAISTAR7
│   └── 09.MAICON     ← docs/ 심볼릭 링크 → C:\TEST\MAICON\docs
├── 02.AREA/           ← 영역별 (지속적 관심사)
├── 03.RESOURCES/      ← 리소스/참고자료
├── 04.ARCHIVE/        ← 아카이브
├── 05.DEBUGGING/      ← 디버깅 노트
├── AI/
├── chatGPT/
├── DAILY/
├── TEMPLATES/
└── skills/
```

**규칙:** 새 프로젝트 → `01.PROJECT/XX.프로젝트명/` 에 생성 (루트 X)

_Last updated: 2026-02-09_
