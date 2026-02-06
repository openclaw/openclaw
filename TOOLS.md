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

### 🏆 하이브리드 코딩 방식 (2026-02-06 확정)

**모든 프로젝트에 적용** — 지니님 승인 완료

```
지니님 (Discord)
    ↓ 지시/브레인스토밍
MAIBOT (오케스트레이터)
    ├── 간단한 작업 → 직접 처리 (문서 수정, git, 노티 등)
    └── 코딩 작업 → Claude Code CLI 실행 (개발, 디버깅, 테스트)
         ↓
    프로젝트 워크스페이스
```

**역할 분담:**
| 역할 | MAIBOT | Claude Code CLI |
|------|--------|----------------|
| 지시 수신 (Discord) | ✅ | — |
| 요구사항 분석 | ✅ | — |
| **코딩/디버깅** | 간단한 것만 | ✅ 메인 |
| **대규모 리팩토링** | — | ✅ |
| 테스트 실행 | 간단한 것 | ✅ |
| 문서화 | ✅ | — |
| git 커밋/푸시 | ✅ | — |
| Discord 노티 | ✅ | — |
| 메모리 관리 | ✅ | — |

**Claude Code 실행 방법:** coding-agent 스킬 참조
- 단발: `claude 'task description'` (pty:true, workdir 지정)
- 장기: background:true로 실행, process:log로 모니터링
- 완료 알림: `moltbot gateway wake` 명령으로 즉시 통보

**과금:** 둘 다 동일 Claude Max 구독 (claude_code_oauth_token)
**장점:** 컨텍스트 분리, 병렬 처리, 코딩 전문성 활용, MAIBOT 여유 확보

**Claude Code 고급 기능 활용:**
| 기능 | 설명 | 사용법 |
|------|------|--------|
| **서브에이전트** | 전문 역할별 에이전트 (`.claude/agents/`) | `--agent test-engineer` |
| **MCP 서버** | 외부 도구 연동 (`.mcp.json`) | 자동 로드 (playwright, n8n 등) |
| **CLAUDE.md** | 프로젝트 가이드 (자동 참조) | 워크스페이스 루트에 배치 |
| **permission-mode** | 자동 승인 모드 | `--permission-mode bypassPermissions` |
| **model 선택** | opus/sonnet 등 | `--model opus` |
| **세션 이어하기** | 이전 작업 이어서 | `--continue` 또는 `--resume` |

**프로젝트별 서브에이전트 구성:**

| 프로젝트 | 에이전트 | MCP |
|----------|----------|-----|
| **MAIBEAUTY** | n8n-architect, content-pipeline, ecommerce-agent-dev, crm-automation, ai-media-producer, test-engineer | playwright, fetcher, context7, magic, n8n-mcp |
| **MAIOSS** | oss-scanner, cve-analyst, report-generator, ai-analyzer, devops-deployer, test-engineer | playwright, fetcher, context7, magic |
| **MAIBOT** | gateway-dev, channel-dev, cli-dev, docs-writer, test-engineer, platform-dev | playwright, fetcher, context7, magic |

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
