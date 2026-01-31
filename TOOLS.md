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

*Last updated: 2026-01-30*
