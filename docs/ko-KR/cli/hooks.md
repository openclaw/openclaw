---
summary: "에이전트 후크를 위한 CLI 참조"
read_when:
  - 에이전트 후크를 관리하려고 할 때
  - 후크를 설치하거나 업데이트하려고 할 때
title: "hooks"
---

# `openclaw hooks`

에이전트 후크를 관리합니다 (`/new`, `/reset` 및 Gateway 시작과 같은 명령에 대한 이벤트 기반 자동화).

관련 사항:

- Hooks: [Hooks](/automation/hooks)
- Plugin hooks: [Plugins](/tools/plugin#plugin-hooks)

## 모든 후크 나열

```bash
openclaw hooks list
```

워크스페이스, 관리 및 번들 디렉토리에서 검색된 모든 후크를 나열합니다.

**옵션:**

- `--eligible`: 자격이 있는 후크만 표시 (요구 사항 충족)
- `--json`: JSON 으로 출력
- `-v, --verbose`: 누락된 요구 사항을 포함한 세부 정보 표시

## 후크 정보 가져오기

```bash
openclaw hooks info <name>
```

특정 후크에 대한 세부 정보를 표시합니다.

**인수:**

- `<name>`: 후크 이름 (예: `session-memory`)

## 후크 자격 검사

```bash
openclaw hooks check
```

후크 자격 상태 요약을 표시합니다 (준비된 항목 vs 준비되지 않은 항목).

## 후크 활성화

```bash
openclaw hooks enable <name>
```

구성에 추가하여 특정 후크를 활성화합니다 (`~/.openclaw/config.json`).

**인수:**

- `<name>`: 후크 이름 (예: `session-memory`)

## 후크 비활성화

```bash
openclaw hooks disable <name>
```

구성을 업데이트하여 특정 후크를 비활성화합니다.

**인수:**

- `<name>`: 후크 이름 (예: `command-logger`)

## 후크 설치

```bash
openclaw hooks install <path-or-spec>
openclaw hooks install <npm-spec> --pin
```

로컬 폴더/아카이브 또는 npm 에서 후크 팩을 설치합니다.

**옵션:**

- `-l, --link`: 복사 대신 로컬 디렉토리를 링크합니다
- `--pin`: npm 설치를 정확한 해결된 `name@version` 으로 기록

## 후크 업데이트

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

설치된 후크 팩을 업데이트합니다 (npm 설치만).

**옵션:**

- `--all`: 추적된 모든 후크 팩 업데이트
- `--dry-run`: 작성하지 않고 변경될 내용 표시

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/hooks.md
workflow: 15
