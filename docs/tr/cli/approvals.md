---
summary: "CLI için `openclaw approvals` başvurusu (gateway veya node ana makineleri için exec onayları)"
read_when:
  - CLI üzerinden exec onaylarını düzenlemek istediğinizde
  - Gateway veya node ana makinelerinde izin listelerini yönetmeniz gerektiğinde
title: "cli/approvals.md"
---

# `openclaw approvals`

**Yerel ana makine**, **gateway ana makinesi** veya bir **node ana makinesi** için exec onaylarını yönetin.
Varsayılan olarak komutlar diskteki yerel onaylar dosyasını hedefler. Gateway’i hedeflemek için `--gateway`, belirli bir node’u hedeflemek için `--node` kullanın.

İlgili:

- Exec onayları: [Exec approvals](/tools/exec-approvals)
- Node’lar: [Nodes](/nodes)

## Yaygın komutlar

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Bir dosyadan onayları değiştirme

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## İzin listesi yardımcıları

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notlar

- `--node`, `openclaw nodes` ile aynı çözücüyü kullanır (id, ad, ip veya id öneki).
- `--agent` varsayılan olarak `"*"`’dur; bu tüm ajanlara uygulanır.
- Node ana makinesi `system.execApprovals.get/set`’u duyurmalıdır (macOS uygulaması veya başsız node ana makinesi).
- Onaylar dosyaları ana makine başına `~/.openclaw/exec-approvals.json` konumunda saklanır.
