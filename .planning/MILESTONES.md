# Milestones

## v0.x — Baseline (shipped)

**Shipped capabilities:**

- Docker provider z hardeningiem (--read-only, no-new-privileges, resource limits)
- gVisor provider zaimplementowany w kodzie (GVisorProvider)
- SSRF defense (iptables blokada metadata endpoints)
- Secret filtering z ENV kontenerów
- Walidacja bind-mountów (denylist system paths + symlink hardening)
- Browser security (blokada niebezpiecznych protokołów i private IPs)
- sandbox-local: 6-warstwowy pipeline (Docker + E2B backend, output scanner, audit log)

**Last phase:** n/a (brownfield — istniejący kod bez GSD)

---

## v1.0 — Security Hardening (current)

**Started:** 2026-04-10
**Goal:** Zamknąć luki zidentyfikowane w audycie bezpieczeństwa

**Phases:**
| # | Name | Status |
|---|------|--------|
| 1 | gVisor Activation | Not started |
| 2 | Capability Hardening | Not started |
| 3 | Firecracker Backend | Not started |
| 4 | Output Sanitization | Not started |
| 5 | Network Isolation | Not started |
| 6 | Pipeline Integration | Not started |
