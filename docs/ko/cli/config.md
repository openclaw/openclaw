---
read_when:
    - 비대화형으로 구성을 읽거나 편집하고 싶습니다.
summary: '`openclaw config`에 대한 CLI 참조(구성 값 가져오기/설정/설정 해제)'
title: 구성
x-i18n:
    generated_at: "2026-02-08T15:48:52Z"
    model: gtx
    provider: google-translate
    source_hash: d60a35f5330f22bc99a0df090590586109d329ddd2ca294aeed191a22560c1c2
    source_path: cli/config.md
    workflow: 15
---

# `openclaw config`

구성 도우미: 경로별로 값을 가져오거나 설정/설정 해제합니다. 하위 명령 없이 실행하여 열기
구성 마법사(동일 `openclaw configure`).

## 예

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## 경로

경로는 점 또는 대괄호 표기법을 사용합니다.

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

특정 상담원을 타겟팅하려면 상담원 목록 색인을 사용하세요.

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## 가치

가능한 경우 값은 JSON5로 구문 분석됩니다. 그렇지 않으면 문자열로 처리됩니다.
사용 `--json` JSON5 구문 분석이 필요합니다.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

편집 후 게이트웨이를 다시 시작하십시오.
