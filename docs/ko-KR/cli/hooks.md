---
summary: "`openclaw hooks`에 대한 CLI 참조 (에이전트 훅)"
read_when:
  - 에이전트 훅을 관리하고 싶을 때
  - 훅을 설치하거나 업데이트하고 싶을 때
title: "hooks"
---

# `openclaw hooks`

에이전트 훅을 관리합니다 (`/new`, `/reset`, 게이트웨이 시작과 같은 명령어에 대한 이벤트 기반 자동화).

관련 문서:

- Hooks: [Hooks](/ko-KR/automation/hooks)
- Plugin hooks: [Plugins](/ko-KR/tools/plugin#plugin-hooks)

## 모든 훅 나열하기

```bash
openclaw hooks list
```

워크스페이스, 관리되고 있는 디렉터리, 번들된 디렉터리에서 발견된 모든 훅을 나열합니다.

**옵션:**

- `--eligible`: 사용 가능한 훅만 표시 (요구 사항 충족)
- `--json`: JSON 형식으로 출력
- `-v, --verbose`: 누락된 요구 사항을 포함한 상세한 정보 표시

**예제 출력:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📎 bootstrap-extra-files ✓ - 에이전트 부트스트랩 중 추가 워크스페이스 부트스트랩 파일 주입
  📝 command-logger ✓ - 모든 명령 이벤트를 중앙 집중식 감사 파일에 기록
  💾 session-memory ✓ - /new 명령이 발급될 때 세션 컨텍스트를 메모리에 저장
```

**예제 (verbose):**

```bash
openclaw hooks list --verbose
```

사용할 수 없는 훅에 대한 누락된 요구 사항을 보여줍니다.

**예제 (JSON):**

```bash
openclaw hooks list --json
```

프로그래밍적으로 사용할 수 있는 구조화된 JSON을 반환합니다.

## 훅 정보 가져오기

```bash
openclaw hooks info <name>
```

특정 훅에 대한 자세한 정보를 보여줍니다.

**인수:**

- `<name>`: 훅 이름 (예: `session-memory`)

**옵션:**

- `--json`: JSON 형식으로 출력

**예제:**

```bash
openclaw hooks info session-memory
```

**출력:**

```
💾 session-memory ✓ Ready

/new 명령이 발급되면 세션 컨텍스트를 메모리에 저장합니다.

세부사항:
  출처: openclaw-bundled
  경로: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  핸들러: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  홈페이지: https://docs.openclaw.ai/automation/hooks#session-memory
  이벤트: command:new

요구 사항:
  구성: ✓ workspace.dir
```

## 훅 자격 상태 확인하기

```bash
openclaw hooks check
```

훅 자격 상태의 요약을 표시합니다 (준비된 훅 수 대 준비되지 않은 훅 수).

**옵션:**

- `--json`: JSON 형식으로 출력

**예제 출력:**

```
훅 상태

총 훅: 4
준비됨: 4
준비되지 않음: 0
```

## 훅 활성화하기

```bash
openclaw hooks enable <name>
```

구성 파일(`~/.openclaw/config.json`)에 추가하여 특정 훅을 활성화합니다.

**참고:** 플러그인이 관리하는 훅은 `openclaw hooks list`에 `plugin:<id>`로 표시되며
여기서 활성화/비활성화할 수 없습니다. 대신 플러그인을 활성화/비활성화하십시오.

**인수:**

- `<name>`: 훅 이름 (예: `session-memory`)

**예제:**

```bash
openclaw hooks enable session-memory
```

**출력:**

```
✓ 활성화된 훅: 💾 session-memory
```

**작동 방식:**

- 훅이 존재하고 사용 가능한지 확인
- 구성 파일의 `hooks.internal.entries.<name>.enabled = true`를 업데이트
- 구성을 디스크에 저장

**활성화 후:**

- 훅이 다시 로드되도록 게이트웨이를 재시작하십시오 (macOS에서는 메뉴 바 앱을 재시작하거나 개발 환경에서는 게이트웨이 프로세스를 재시작).

## 훅 비활성화하기

```bash
openclaw hooks disable <name>
```

구성을 업데이트하여 특정 훅을 비활성화합니다.

**인수:**

- `<name>`: 훅 이름 (예: `command-logger`)

**예제:**

```bash
openclaw hooks disable command-logger
```

**출력:**

```
⏸ 비활성화된 훅: 📝 command-logger
```

**비활성화 후:**

- 훅이 다시 로드되도록 게이트웨이를 재시작하십시오

## 훅 설치하기

```bash
openclaw hooks install <path-or-spec>
openclaw hooks install <npm-spec> --pin
```

로컬 폴더/아카이브 또는 npm에서 훅 팩을 설치합니다.

npm 사양은 **레지스트리 전용**입니다 (패키지 이름 + 선택적 버전/태그). Git/URL/파일
사양은 거부됩니다. 의존성 설치는 안전성을 위해 `--ignore-scripts`로 실행됩니다.

**작동 방식:**

- 훅 팩을 `~/.openclaw/hooks/<id>`에 복사
- 설치된 훅을 `hooks.internal.entries.*`에서 활성화
- 설치 기록을 `hooks.internal.installs`에 기록

**옵션:**

- `-l, --link`: 복사하는 대신 로컬 디렉토리를 연결 (`hooks.internal.load.extraDirs`에 추가)
- `--pin`: npm 설치를 `hooks.internal.installs`에 정확한 해결된 `name@version`으로 기록

**지원되는 아카이브:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**예제:**

```bash
# 로컬 디렉토리
openclaw hooks install ./my-hook-pack

# 로컬 아카이브
openclaw hooks install ./my-hook-pack.zip

# NPM 패키지
openclaw hooks install @openclaw/my-hook-pack

# 복사 없이 로컬 디렉토리 연결
openclaw hooks install -l ./my-hook-pack
```

## 훅 업데이트하기

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

설치된 훅 팩을 업데이트합니다 (npm 설치만 해당).

**옵션:**

- `--all`: 추적된 모든 훅 팩 업데이트
- `--dry-run`: 쓰기 없이 변경 사항 표시

저장된 무결성 해시가 존재하고 가져온 아티팩트 해시가 변경되면,
OpenClaw는 경고를 출력하고 진행하기 전에 확인을 요청합니다. CI/비대화형 실행에서는
전역 `--yes` 플래그를 사용하여 프롬프트를 건너뛰세요.

## 번들된 훅

### session-memory

/new 명령을 발급할 때 세션 컨텍스트를 메모리에 저장합니다.

**활성화:**

```bash
openclaw hooks enable session-memory
```

**출력:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**참조:** [session-memory 문서](/ko-KR/automation/hooks#session-memory)

### bootstrap-extra-files

에이전트 부트스트랩 중 추가 부트스트랩 파일을 주입합니다 (예: 모노레포 로컬 `AGENTS.md` / `TOOLS.md`).

**활성화:**

```bash
openclaw hooks enable bootstrap-extra-files
```

**참조:** [bootstrap-extra-files 문서](/ko-KR/automation/hooks#bootstrap-extra-files)

### command-logger

모든 명령 이벤트를 중앙 집중식 감사 파일에 기록합니다.

**활성화:**

```bash
openclaw hooks enable command-logger
```

**출력:** `~/.openclaw/logs/commands.log`

**로그 보기:**

```bash
# 최근 명령
tail -n 20 ~/.openclaw/logs/commands.log

# 보기 좋게 인쇄
cat ~/.openclaw/logs/commands.log | jq .

# 작업별 필터
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**참조:** [command-logger 문서](/ko-KR/automation/hooks#command-logger)

### boot-md

게이트웨이가 시작될 때 `BOOT.md`를 실행합니다 (채널 시작 후).

**이벤트**: `gateway:startup`

**활성화**:

```bash
openclaw hooks enable boot-md
```

**참조:** [boot-md 문서](/ko-KR/automation/hooks#boot-md)
