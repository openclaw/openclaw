# TOOLS.md - Local Notes

Skills define *how* tools work. This file is for *your* specifics — the stuff that's unique to your setup.

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

### Discord 노티 규칙
- **절대 금지**: `#일반` 채널(1466615738512179394)에 메시지 전송 금지 (보안 위험)
- **DM 전용**: 지니님 DM 채널(1466624220632059934)으로만 전송
- **민감 정보 제거**: 규정 문서 번호, 내부 시스템명, 제어기 정보 등 비공개 정보 포함 금지

### Obsidian 볼트
- **경로:** `C:\Users\jini9\OneDrive\Documents\JINI_SYNC`
- **구조:** PARA 기반 (00.DAILY, 01.PROJECT, 02.AREA, 03.RESOURCES, 04.ARCHIVE)
- **기타 폴더:** AI, chatGPT, DAILY, TEMPLATES, 05.DEBUGGING, skills
- **CLI:** obsidian-cli 미지원 (Windows) → 직접 파일 읽기/쓰기로 연동
- **동기화:** OneDrive

*Last updated: 2026-02-05*
