---
summary: "Sanggunian ng CLI para sa `openclaw approvals` (mga exec approval para sa gateway o mga node host)"
read_when:
  - Gusto mong mag-edit ng mga exec approval mula sa CLI
  - Kailangan mong pamahalaan ang mga allowlist sa gateway o mga node host
title: "mga pag-apruba"
---

# `openclaw approvals`

28. Pamahalaan ang mga exec approval para sa **local host**, **gateway host**, o isang **node host**.
29. Bilang default, ang mga command ay tumatarget sa lokal na approvals file sa disk. 30. Gamitin ang `--gateway` upang i-target ang gateway, o `--node` upang i-target ang isang partikular na node.

Related:

- Exec approvals: [Exec approvals](/tools/exec-approvals)
- Nodes: [Nodes](/nodes)

## Mga karaniwang command

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Palitan ang mga approval mula sa isang file

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Mga helper ng allowlist

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Mga tala

- Gumagamit ang `--node` ng parehong resolver gaya ng `openclaw nodes` (id, name, ip, o id prefix).
- Ang `--agent` ay naka-default sa `"*"`, na nalalapat sa lahat ng agent.
- Dapat i-advertise ng node host ang `system.execApprovals.get/set` (macOS app o headless node host).
- Ang mga approvals file ay naka-store kada host sa `~/.openclaw/exec-approvals.json`.
