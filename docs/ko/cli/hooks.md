---
read_when:
    - 에이전트 후크를 관리하고 싶습니다.
    - 후크를 설치하거나 업데이트하고 싶습니다.
summary: '`openclaw hooks`에 대한 CLI 참조(에이전트 후크)'
title: 후크
x-i18n:
    generated_at: "2026-02-08T15:52:37Z"
    model: gtx
    provider: google-translate
    source_hash: b3cb5c4ce63c5ad3457cd771b56c30712c9b835edcd54acbac199c947ebea88b
    source_path: cli/hooks.md
    workflow: 15
---

# `openclaw hooks`

에이전트 후크 관리(다음과 같은 명령에 대한 이벤트 기반 자동화) `/new`, `/reset`및 게이트웨이 시작).

관련된:

- 후크: [후크](/automation/hooks)
- 플러그인 후크: [플러그인](/tools/plugin#plugin-hooks)

## 모든 후크 나열

```bash
openclaw hooks list
```

작업공간, 관리 및 번들 디렉토리에서 발견된 모든 후크를 나열합니다.

**옵션:**

- `--eligible`: 적합한 후크만 표시(요구 사항 충족)
- `--json`: JSON으로 출력
- `-v, --verbose`: 누락된 요구사항을 포함한 자세한 정보를 표시합니다.

**예제 출력:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**예(상세):**

```bash
openclaw hooks list --verbose
```

부적격 후크에 대한 누락된 요구 사항을 표시합니다.

**예(JSON):**

```bash
openclaw hooks list --json
```

프로그래밍 방식으로 사용하기 위해 구조화된 JSON을 반환합니다.

## 후크 정보 얻기

```bash
openclaw hooks info <name>
```

특정 후크에 대한 자세한 정보를 표시합니다.

**인수:**

- `<name>`: 후크 이름(예: `session-memory`)

**옵션:**

- `--json`: JSON으로 출력

**예:**

```bash
openclaw hooks info session-memory
```

**산출:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## Hooks 적격성 확인

```bash
openclaw hooks check
```

후크 적격 상태 요약을 표시합니다(준비된 수와 준비되지 않은 수).

**옵션:**

- `--json`: JSON으로 출력

**예제 출력:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## 후크 활성화

```bash
openclaw hooks enable <name>
```

특정 후크를 구성에 추가하여 활성화합니다(`~/.openclaw/config.json`).

**메모:** 플러그인으로 관리되는 후크 표시 `plugin:<id>` ~에 `openclaw hooks list` 그리고
여기서는 활성화/비활성화할 수 없습니다. 대신 플러그인을 활성화/비활성화하세요.

**인수:**

- `<name>`: 후크 이름(예: `session-memory`)

**예:**

```bash
openclaw hooks enable session-memory
```

**산출:**

```
✓ Enabled hook: 💾 session-memory
```

**기능:**

- 후크가 존재하고 적합한지 확인합니다.
- 업데이트 `hooks.internal.entries.<name>.enabled = true` 귀하의 구성에서
- 구성을 디스크에 저장

**활성화한 후:**

- 후크를 다시 로드하도록 게이트웨이를 다시 시작합니다(macOS에서 메뉴 표시줄 앱을 다시 시작하거나 개발에서 게이트웨이 프로세스를 다시 시작).

## 후크 비활성화

```bash
openclaw hooks disable <name>
```

구성을 업데이트하여 특정 후크를 비활성화합니다.

**인수:**

- `<name>`: 후크 이름(예: `command-logger`)

**예:**

```bash
openclaw hooks disable command-logger
```

**산출:**

```
⏸ Disabled hook: 📝 command-logger
```

**비활성화 후:**

- 후크가 다시 로드되도록 게이트웨이를 다시 시작하세요.

## 후크 설치

```bash
openclaw hooks install <path-or-spec>
```

로컬 폴더/아카이브 또는 npm에서 후크 팩을 설치합니다.

**기능:**

- 후크 팩을 다음으로 복사합니다. `~/.openclaw/hooks/<id>`
- 설치된 후크를 활성화합니다. `hooks.internal.entries.*`
- 아래에 설치를 기록합니다. `hooks.internal.installs`

**옵션:**

- `-l, --link`: 복사하는 대신 로컬 디렉터리를 연결합니다(다음에 추가합니다). `hooks.internal.load.extraDirs`)

**지원되는 아카이브:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**예:**

```bash
# Local directory
openclaw hooks install ./my-hook-pack

# Local archive
openclaw hooks install ./my-hook-pack.zip

# NPM package
openclaw hooks install @openclaw/my-hook-pack

# Link a local directory without copying
openclaw hooks install -l ./my-hook-pack
```

## 후크 업데이트

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

설치된 후크 팩을 업데이트합니다(npm 설치만 해당).

**옵션:**

- `--all`: 추적된 모든 후크 팩을 업데이트합니다.
- `--dry-run`: 글을 쓰지 않고도 무엇이 바뀔지 보여줌

## 번들 후크

### 세션 메모리

발행 시 세션 컨텍스트를 메모리에 저장합니다. `/new`.

**할 수 있게 하다:**

```bash
openclaw hooks enable session-memory
```

**산출:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**보다:** [세션 메모리 문서](/automation/hooks#session-memory)

### 명령 로거

모든 명령 이벤트를 중앙 감사 파일에 기록합니다.

**할 수 있게 하다:**

```bash
openclaw hooks enable command-logger
```

**산출:** `~/.openclaw/logs/commands.log`

**로그 보기:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**보다:** [명령 로거 문서](/automation/hooks#command-logger)

### 영혼의 악

스왑 주입 `SOUL.md` 만족하다 `SOUL_EVIL.md` 퍼지 기간 동안 또는 무작위로 발생합니다.

**할 수 있게 하다:**

```bash
openclaw hooks enable soul-evil
```

**보다:** [소울 이블 훅](/hooks/soul-evil)

### 부팅-MD

실행 `BOOT.md` 게이트웨이가 시작될 때(채널이 시작된 후)

**이벤트**: `gateway:startup`

**할 수 있게 하다**: 

```bash
openclaw hooks enable boot-md
```

**보다:** [boot-md 문서](/automation/hooks#boot-md)
