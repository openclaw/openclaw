---
summary: "CLI reference for `openclaw approvals` (exec approvals for gateway or node hosts)"
read_when:
  - You want to edit exec approvals from the CLI
  - You need to manage allowlists on gateway or node hosts
title: "approvals"
x-i18n:
  source_hash: 4329cdaaec2c5f5d619415b6431196512d4834dc1ccd7363576f03dd9b845130
---

# `openclaw approvals`

**로컬 호스트**, **게이트웨이 호스트** 또는 **노드 호스트**에 대한 실행 승인을 관리합니다.
기본적으로 명령은 디스크의 로컬 승인 파일을 대상으로 합니다. 게이트웨이를 대상으로 하려면 `--gateway`를 사용하고, 특정 노드를 대상으로 하려면 `--node`를 사용하세요.

관련 항목:

- 실행 승인: [실행 승인](/tools/exec-approvals)
- 노드: [노드](/nodes)

## 일반적인 명령

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## 파일에서 승인 교체

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## 허용 목록 도우미

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## 메모

- `--node`는 `openclaw nodes`(id, 이름, ip 또는 id 접두사)와 동일한 확인자를 사용합니다.
- `--agent`의 기본값은 `"*"`로, 모든 에이전트에 적용됩니다.
- 노드 호스트는 `system.execApprovals.get/set`(macOS 앱 또는 헤드리스 노드 호스트)를 광고해야 합니다.
- 승인 파일은 호스트별로 `~/.openclaw/exec-approvals.json`에 저장됩니다.
