---
summary: "Gateway 또는 노드 호스트에 대한 exec 승인용 `openclaw approvals` CLI 레퍼런스"
read_when:
  - CLI 에서 exec 승인을 편집하려는 경우
  - Gateway 또는 노드 호스트의 허용 목록을 관리해야 하는 경우
title: "승인"
---

# `openclaw approvals`

**로컬 호스트**, **Gateway 호스트**, 또는 **노드 호스트**에 대한 exec 승인을 관리합니다.
기본적으로 명령은 디스크에 있는 로컬 승인 파일을 대상으로 합니다. Gateway 를 대상으로 하려면 `--gateway` 를 사용하고, 특정 노드를 대상으로 하려면 `--node` 를 사용하십시오.

관련 항목:

- Exec 승인: [Exec approvals](/tools/exec-approvals)
- 노드: [Nodes](/nodes)

## 공통 명령

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

## 참고

- `--node` 는 `openclaw nodes` 과 동일한 리졸버를 사용합니다 (id, name, ip, 또는 id 접두사).
- `--agent` 의 기본값은 `"*"` 이며, 이는 모든 에이전트에 적용됩니다.
- 노드 호스트는 `system.execApprovals.get/set` 을 광고해야 합니다 (macOS 앱 또는 헤드리스 노드 호스트).
- 승인 파일은 호스트별로 `~/.openclaw/exec-approvals.json` 에 저장됩니다.
