---
summary: "Gateway 또는 노드 호스트에서 실행 승인을 위한 CLI 참조"
read_when:
  - CLI 에서 실행 승인을 편집하려고 할 때
  - Gateway 또는 노드 호스트에서 허용 목록을 관리해야 할 때
title: "approvals"
---

# `openclaw approvals`

**로컬 호스트**, **Gateway 호스트** 또는 **노드 호스트** 에 대한 실행 승인을 관리합니다.
기본적으로 명령은 디스크의 로컬 승인 파일을 대상으로 합니다. Gateway 를 대상으로 하려면 `--gateway` 를, 특정 노드를 대상으로 하려면 `--node` 를 사용합니다.

관련 사항:

- 실행 승인: [Exec approvals](/tools/exec-approvals)
- 노드: [Nodes](/nodes)

## 일반적인 명령

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## 파일에서 승인 바꾸기

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

- `--node` 는 `openclaw nodes` 와 동일한 확인자를 사용합니다 (id, name, ip 또는 id 접두사).
- `--agent` 기본값은 `"*"` 이며, 이는 모든 에이전트에 적용됩니다.
- 노드 호스트는 `system.execApprovals.get/set` 을 광고해야 합니다 (macOS 앱 또는 헤드리스 노드 호스트).
- 승인 파일은 호스트당 `~/.openclaw/exec-approvals.json` 에 저장됩니다.

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/approvals.md
workflow: 15
