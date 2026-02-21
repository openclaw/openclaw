---
summary: "`openclaw config` CLI 참조 (설정 값 가져오기/설정하기/해제하기)"
read_when:
  - 설정을 비대화식으로 읽거나 편집하고 싶을 때
title: "config"
---

# `openclaw config`

설정 도우미: 경로로 값을 가져오기/설정하기/해제하기. 하위 명령어 없이 실행하면 구성 마법사가 열립니다 (`openclaw configure`와 동일).

## 예제

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## 경로

경로는 점 표기법이나 대괄호 표기법을 사용합니다:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

에이전트 목록 인덱스를 사용하여 특정 에이전트를 대상으로 지정하세요:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## 값

값은 가능할 경우 JSON5로 파싱되며, 그렇지 않으면 문자열로 처리됩니다. JSON5 파싱을 요구하려면 `--strict-json`을 사용하세요. `--json`은 레거시 별칭으로 계속 지원됩니다.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --strict-json
openclaw config set channels.whatsapp.groups '["*"]' --strict-json
```

수정 후 게이트웨이를 재시작하세요.
