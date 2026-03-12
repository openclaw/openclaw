---
name: upstream-sync
description: "Safely merge OpenClaw upstream updates into MAIBOT without losing custom files. Use when: updating MAIBOT to latest OpenClaw version, '업데이트', 'upstream 머지', '최신 버전으로 업데이트'. NOT for: regular git pull on non-MAIBOT repos."
---

# Upstream Sync

MAIBOT(`C:\MAIBOT`)은 OpenClaw의 포크. upstream(`openclaw/openclaw`)의 최신 변경을 안전하게 머지한다.

## Custom Files (충돌 시 항상 ours 우선)

```
MEMORY.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md, AGENTS.md
memory/                  # 프로젝트 기록
skills/                  # 커스텀 스킬
```

## Merge Procedure

| #   | Step         | Command                                                            | Notes                                              |
| --- | ------------ | ------------------------------------------------------------------ | -------------------------------------------------- |
| 1   | 사전 점검    | `git status`                                                       | dirty → 먼저 커밋 (stash 금지). `main` 브랜치 확인 |
| 2   | Fetch        | `git fetch upstream`                                               |                                                    |
| 3   | 변경량 확인  | `git log --oneline HEAD..upstream/main \| Select-Object -First 20` | 변경 없으면 종료                                   |
| 4   | Merge        | `git merge upstream/main --no-edit`                                | 충돌 시 아래 규칙 적용                             |
| 5   | Build/Test   | `pnpm install && pnpm build && pnpm test`                          | 실패 → 수정 or `git merge --abort`                 |
| 6   | Push         | `git push origin main`                                             |                                                    |
| 7   | Discord 보고 | DM channel:1466624220632059934                                     | 커밋 수, 충돌 해결, 빌드 결과                      |

## Conflict Resolution Principles

1. **Custom files** (위 목록) → `git checkout --ours <file> && git add <file>` — 항상 우리 것 유지
2. **OpenClaw core files** → 내용 확인 후 수동 해결 (upstream 기능 유지 우선)
3. **해결 불가** → `git merge --abort` 후 지니님에게 보고

See [references/conflict-guide.md](references/conflict-guide.md) for detailed conflict resolution cases.
