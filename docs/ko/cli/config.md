---
summary: "`openclaw config`에 대한 CLI 참조(구성 값 가져오기/설정하기/해제하기)"
read_when:
  - 구성을 비대화형으로 읽거나 편집하려는 경우
title: "config"
---

# `openclaw config`

구성 도우미: 경로로 값을 가져오기/설정하기/해제하기. 하위 명령 없이 실행하면
구성 마법사를 엽니다(`openclaw configure`와 동일).

## 예제

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## 경로

경로는 점 표기법 또는 대괄호 표기법을 사용합니다:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

특정 에이전트를 대상으로 하려면 에이전트 목록 인덱스를 사용하십시오:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## 값

값은 가능한 경우 JSON5로 파싱되며, 그렇지 않으면 문자열로 처리됩니다.
JSON5 파싱을 요구하려면 `--json`을 사용하십시오.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

편집 후 Gateway(게이트웨이)를 재시작하십시오.
