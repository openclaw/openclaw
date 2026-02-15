---
summary: "CLI reference for `openclaw hooks` (agent hooks)"
read_when:
  - You want to manage agent hooks
  - You want to install or update hooks
title: "hooks"
x-i18n:
  source_hash: 49cd4ff0de2c941bd127f2119b07540819022a6b8f67a297f1b086708c58db5d
---

# `openclaw hooks`

에이전트 후크(`/new`, `/reset` 및 게이트웨이 시작과 같은 명령에 대한 이벤트 기반 자동화)를 관리합니다.

관련 항목:

- 후크: [후크](/automation/hooks)
- 플러그인 후크: [플러그인](/tools/plugin#plugin-hooks)

## 모든 후크 나열

```bash
openclaw hooks list
```

작업공간, 관리 및 번들 디렉토리에서 발견된 모든 후크를 나열합니다.

**옵션:**

- `--eligible`: 적합한 후크만 표시(요구 사항 충족)
- `--json` : JSON으로 출력
- `-v, --verbose`: 누락된 요구사항을 포함한 자세한 정보를 표시합니다.

**예제 출력:**

```
Hooks (3/3 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
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

- `--json` : JSON으로 출력

**예:**

```bash
openclaw hooks info session-memory
```

**출력:**

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

## Hooks 적격성을 확인하세요

```bash
openclaw hooks check
```

후크 적격 상태 요약을 표시합니다(준비된 수와 준비되지 않은 수).

**옵션:**

- `--json` : JSON으로 출력

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

구성(`~/.openclaw/config.json`)에 특정 후크를 추가하여 활성화합니다.

**참고:** 플러그인으로 관리되는 후크는 `openclaw hooks list`에 `plugin:<id>`를 표시하고
여기서는 활성화/비활성화할 수 없습니다. 대신 플러그인을 활성화/비활성화하세요.

**인수:**

- `<name>`: 후크 이름(예: `session-memory`)

**예:**

```bash
openclaw hooks enable session-memory
```

**출력:**

```
✓ Enabled hook: 💾 session-memory
```

**기능:**

- 후크가 존재하고 적합한지 확인합니다.
- 구성에서 `hooks.internal.entries.<name>.enabled = true` 업데이트
- 구성을 디스크에 저장

**활성화 후:**

- 게이트웨이를 다시 시작하여 후크를 다시 로드합니다(macOS에서 메뉴 표시줄 앱을 다시 시작하거나 개발에서 게이트웨이 프로세스를 다시 시작).

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

**출력:**

```
⏸ Disabled hook: 📝 command-logger
```

**비활성화 후:**

- 게이트웨이를 다시 시작하여 후크를 다시 로드합니다.

## 후크 설치

```bash
openclaw hooks install <path-or-spec>
```

로컬 폴더/아카이브 또는 npm에서 후크 팩을 설치합니다.

**기능:**

- 후크 팩을 `~/.openclaw/hooks/<id>`에 복사합니다.
- `hooks.internal.entries.*`에 설치된 후크를 활성화합니다.
- `hooks.internal.installs` 아래에 설치를 기록합니다.

**옵션:**

- `-l, --link`: 복사하는 대신 로컬 디렉터리를 연결합니다. (`hooks.internal.load.extraDirs`에 추가)

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

## 업데이트 후크

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

설치된 후크 팩을 업데이트합니다(npm 설치만 해당).

**옵션:**

- `--all`: 추적된 모든 후크 팩을 업데이트합니다.
- `--dry-run`: 쓰지 않고 무엇이 바뀌는지 보여줍니다.

## 번들 후크

### 세션 메모리

`/new`를 실행할 때 세션 컨텍스트를 메모리에 저장합니다.

**활성화:**

```bash
openclaw hooks enable session-memory
```

**출력:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**참조:** [세션 메모리 문서](/automation/hooks#session-memory)

### 명령 로거

모든 명령 이벤트를 중앙 감사 파일에 기록합니다.

**활성화:**

```bash
openclaw hooks enable command-logger
```

**출력:** `~/.openclaw/logs/commands.log`

**로그 보기:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**참조:** [명령 로거 문서](/automation/hooks#command-logger)

### 부팅-MD

게이트웨이가 시작되면(채널 시작 후) `BOOT.md`를 실행합니다.

**이벤트**: `gateway:startup`

**활성화**:

```bash
openclaw hooks enable boot-md
```

**참조:** [boot-md 문서](/automation/hooks#boot-md)
