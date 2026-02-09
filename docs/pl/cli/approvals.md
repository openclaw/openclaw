---
summary: "Referencja CLI dla `openclaw approvals` (zatwierdzanie wykonania (exec) dla hostów Gateway lub węzłów)"
read_when:
  - Chcesz edytować zatwierdzanie wykonania (exec) z poziomu CLI
  - Musisz zarządzać listami dozwolonych na hostach Gateway lub węzłów
title: "approvals"
---

# `openclaw approvals`

Zarządzaj zatwierdzaniem wykonania (exec) dla **hosta lokalnego**, **hosta Gateway**, lub **hosta węzła**.
Domyślnie polecenia są kierowane do lokalnego pliku zatwierdzeń na dysku. Użyj `--gateway`, aby wskazać Gateway, lub `--node`, aby wskazać konkretny węzeł.

Powiązane:

- Zatwierdzanie wykonania (exec): [Exec approvals](/tools/exec-approvals)
- Węzły: [Nodes](/nodes)

## Typowe polecenia

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Zastąp zatwierdzenia z pliku

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Pomocnicy list dozwolonych

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Uwagi

- `--node` używa tego samego mechanizmu rozwiązywania co `openclaw nodes` (id, nazwa, IP lub prefiks id).
- `--agent` domyślnie ma wartość `"*"`, co ma zastosowanie do wszystkich agentów.
- Host węzła musi reklamować `system.execApprovals.get/set` (aplikacja na macOS lub bezgłowy host węzła).
- Pliki zatwierdzeń są przechowywane per host w `~/.openclaw/exec-approvals.json`.
