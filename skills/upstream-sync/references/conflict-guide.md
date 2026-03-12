# Upstream Sync — Conflict Resolution Guide

충돌 유형별 해결 방법 상세 가이드.

---

## 1. 우리 것 우선 (Ours) — Custom Files

**대상**: `MEMORY.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `AGENTS.md`, `memory/*`, `skills/*`

**이유**: 이 파일들은 MAIBOT 고유 설정/데이터. upstream에 같은 이름 파일이 있어도 내용이 완전히 다름.

**해결**:

```powershell
git checkout --ours MEMORY.md SOUL.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md AGENTS.md
git checkout --ours memory/
git checkout --ours skills/
git add MEMORY.md SOUL.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md AGENTS.md memory/ skills/
```

**주의**: upstream이 이 파일을 삭제한 경우에도 우리 버전을 유지.

---

## 2. 양쪽 유지 (Manual Merge) — Config/Package Files

**대상**: `package.json`, `tsconfig.json`, `.gitignore`, config 파일들

**이유**: upstream의 새 의존성/설정이 필요하지만, 우리가 추가한 커스텀 설정도 유지해야 함.

**해결**:

1. 충돌 마커(`<<<<<<<`, `=======`, `>>>>>>>`) 확인
2. upstream의 새 항목(dependencies, scripts 등)을 수용
3. 우리가 추가한 항목(커스텀 scripts, 추가 deps)도 유지
4. 중복/모순 항목은 upstream 우선 (기능 호환성)

```powershell
# 충돌 파일 열어서 수동 편집 후
git add package.json
```

**예시 — `package.json` 충돌**:

```
<<<<<<< HEAD
"custom-script": "node custom.js",
=======
"new-upstream-script": "node upstream.js",
>>>>>>> upstream/main
```

→ 양쪽 모두 유지:

```json
"custom-script": "node custom.js",
"new-upstream-script": "node upstream.js",
```

---

## 3. Upstream 우선 (Theirs) — Core Source Code

**대상**: `src/*`, `extensions/*`, `dist/*`, `docs/*` (OpenClaw 공식 문서)

**이유**: 핵심 기능 코드는 upstream의 최신 버전을 따라야 정상 동작.

**해결**:

```powershell
git checkout --theirs src/some-file.ts
git add src/some-file.ts
```

**예외**: 우리가 core 소스를 의도적으로 패치한 경우 (매우 드묾) → 패치 내용을 upstream 변경에 재적용.

---

## 4. 삭제 vs 수정 충돌 (Delete/Modify)

**upstream이 파일 삭제 + 우리가 수정**:

- Custom file → 우리 버전 유지: `git add <file>`
- Core file → upstream 삭제 수용: `git rm <file>`

**우리가 파일 삭제 + upstream이 수정**:

- 보통 발생 안 함 (core 파일 삭제 안 하므로)
- 발생 시 upstream 버전 수용: `git checkout --theirs <file> && git add <file>`

---

## 5. 바이너리 파일 충돌

**대상**: 이미지, 폰트 등

**해결**: upstream 버전 사용 (우리가 커스텀 바이너리를 넣은 경우가 아니면)

```powershell
git checkout --theirs assets/some-image.png
git add assets/some-image.png
```

---

## 6. 해결 불가 시 롤백

복잡한 충돌이 다수 발생하거나 빌드가 깨지는 경우:

```powershell
git merge --abort
```

지니님에게 상황 보고 후 함께 해결 방안 논의.

---

## Quick Reference

| 충돌 유형                       | 전략              | 명령어                         |
| ------------------------------- | ----------------- | ------------------------------ |
| Custom files (MEMORY, SOUL 등)  | **Ours**          | `git checkout --ours <file>`   |
| Config (package.json 등)        | **Manual merge**  | 수동 편집                      |
| Core source (src/, extensions/) | **Theirs**        | `git checkout --theirs <file>` |
| Delete vs Modify (custom)       | **Keep ours**     | `git add <file>`               |
| Delete vs Modify (core)         | **Accept delete** | `git rm <file>`                |
| Binary files                    | **Theirs**        | `git checkout --theirs <file>` |
| 해결 불가                       | **Abort**         | `git merge --abort`            |
