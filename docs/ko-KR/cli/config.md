---
summary: "설정 값을 얻기/설정/설정 해제하기 위한 CLI 참조"
read_when:
  - 비대화형으로 설정을 읽거나 편집하려고 할 때
title: "config"
---

# `openclaw config`

설정 도우미: 경로별로 값을 얻기/설정/설정 해제합니다. 하위 명령 없이 실행하면
구성 마법사를 엽니다 (OpenClaw configure 와 동일).

## 예시

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## 경로

경로는 점 또는 괄호 표기법을 사용합니다:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

에이전트 목록 인덱스를 사용하여 특정 에이전트를 대상으로 합니다:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## 값

값은 가능할 때 JSON5 로 구문 분석됩니다. 그렇지 않으면 문자열로 처리됩니다.
JSON5 구문 분석이 필요하려면 `--strict-json` 을 사용합니다. `--json` 은 여전히 레거시 별칭으로 지원됩니다.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --strict-json
openclaw config set channels.whatsapp.groups '["*"]' --strict-json
```

편집 후 Gateway 를 다시 시작합니다.

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/config.md
workflow: 15
