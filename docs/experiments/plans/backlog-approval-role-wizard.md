---
summary: "Backlog vivo de tasks para evolução do Approval Role Wizard"
owner: "anarkaike"
status: "active"
last_updated: "2026-02-16"
title: "Backlog — Approval Role Wizard"
---

# Backlog — Approval Role Wizard

## Now

- [ ] Implementar policy map e schema de validação
- [ ] Integrar wizard ao fluxo de approve
- [x] Adicionar suporte inicial a `role` no `pairing approve` (CLI + persistência)
- [x] Implementar confirmação forte para `superadmin` no CLI (`--confirm-superadmin`)
- [ ] Criar audit log append-only

## Next

- [ ] Comandos `role get/set/revoke`
- [ ] Rollback assistido para downgrade de role
- [ ] Métricas de approvals por role

## Later

- [ ] UI no Control Panel para revisão de access policies
- [ ] Templates de policy por ambiente (dev/prod)
- [ ] Alertas automáticos para concessões superadmin
