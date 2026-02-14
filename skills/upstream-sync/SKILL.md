---
name: upstream-sync
description: Safely merge OpenClaw upstream updates into MAIBOT without conflicts. Use when updating MAIBOT to the latest OpenClaw version, syncing with upstream, or when the user says "업데이트", "upstream 머지", "최신 버전으로 업데이트".
---

# Upstream Sync

MAIBOT(C:\MAIBOT)은 OpenClaw의 포크. upstream(`openclaw/openclaw`)의 최신 변경을 안전하게 머지한다.

## 우리만의 커스텀 파일 (충돌 시 우리 것 우선)

이 파일들은 OpenClaw upstream에 없거나, 우리가 덮어쓴 파일. 머지 충돌 시 **항상 우리 버전(ours)을 유지**:

```
MEMORY.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md, AGENTS.md
memory/                  # 프로젝트 기록
skills/                  # 커스텀 스킬 (weather, github, upstream-sync 등)
```

## 업데이트 절차

### 1. 사전 점검

```powershell
cd C:\MAIBOT
git status
```

- 커밋 안 된 변경이 있으면 먼저 커밋 (stash 사용 금지 — 멀티에이전트 안전)
- 현재 브랜치가 `main`인지 확인

### 2. upstream fetch

```powershell
git fetch upstream
```

### 3. 변경량 미리 확인

```powershell
git log --oneline HEAD..upstream/main | Select-Object -First 20
git diff --stat HEAD..upstream/main
```

변경이 없으면 "이미 최신" 보고 후 종료.

### 4. 머지 (충돌 시 ours 전략)

```powershell
git merge upstream/main --no-edit
```

충돌 발생 시:

1. 커스텀 파일(위 목록) → `git checkout --ours <file>; git add <file>`
2. 그 외 파일 → 내용 확인 후 수동 해결
3. `git merge --continue`

### 5. 빌드/테스트 검증

```powershell
pnpm install
pnpm build
pnpm test
```

실패 시 원인 분석 → 수정 → 재커밋. 해결 불가 시 `git merge --abort`로 롤백 후 지니님에게 보고.

### 6. 푸시

```powershell
git push origin main
```

### 7. Discord 보고

업데이트 결과를 DM(channel:1466624220632059934)에 보고:

- 머지된 커밋 수
- 충돌 유무 및 해결 내역
- 빌드/테스트 결과
