# State — OpenClaw Security Hardening

## Current Position

Phase: Not started (requirements defined)
Plan: .planning/ROADMAP.md
Status: Ready to plan Phase 1
Last activity: 2026-04-10 — Milestone v1.0 Security Hardening initialized

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-10)

**Core value:** Agent AI nie może uciec z sandboxa i przejąć kontroli nad hostem.
**Current focus:** Phase 1 — gVisor Activation

## Next Step

```
/gsd:plan-phase 1
```

Phase 1: gVisor Activation — zainstaluj runsc na Ubuntu, zweryfikuj health check, aktywuj auto-detection.

## Accumulated Context

### Audyt bezpieczeństwa 2026-04-10

Zidentyfikowane luki (priorytet malejący):

1. **KRYTYCZNE** — brak gVisor na hoście Ubuntu (kontenery dzielą kernel)
2. **WYSOKIE** — cap_drop niekompletne (NET_RAW/NET_ADMIN zamiast ALL)
3. **WYSOKIE** — brak output sanitization w openclawA (jest w sandbox-local)
4. **WYSOKIE** — brak izolacji sieciowej Ubuntu → Proxmox management
5. **ŚREDNIE** — Firecracker backend niezaimplementowany (throw PR2)

### Powiązane projekty

- `openclawA` — główny projekt (providers, hardening, docker)
- `sandbox-local` — oddzielna implementacja 6-warstwowego pipeline
  - output-scanner.mjs — gotowy do portowania do TypeScript
  - static-analysis.py — Python AST scanner (21 wzorców)
  - docker-sandbox.mjs — Docker backend z 9 flagami hardening

### Kluczowe pliki do edycji (Phase 1-3)

- `src/agents/sandbox/provider-resolver.ts` — DETECTION_ORDER
- `src/agents/sandbox/providers/gvisor-provider.ts` — już istnieje
- `src/agents/sandbox/providers/firecracker-provider.ts` — do stworzenia
- `src/agents/sandbox/docker.ts` — buildSandboxCreateArgs()
- `docker-compose.yml` — cap_drop dla gateway i CLI

### Proxmox KVM uwaga

Firecracker wymaga `/dev/kvm`. Proxmox domyślnie nie udostępnia KVM do VM.
Wymagana konfiguracja w Proxmox: `Hardware → Processors → Type: host` lub `kvm=1`.
Sprawdź: `ls /dev/kvm` na Ubuntu Server.

### Firecracker — już zaimplementowany w PR #43863

PR jest OPEN od marca 2026. Zawiera Go vm-runner service + TypeScript gRPC client.
Phase 3 to NIE implementacja od zera — to merge + lokalny setup vm-runner.

Otwarte PR-y (jamtujest → openclaw/openclaw):

- PR #41437 — feat/pluggable-sandbox-providers (oryginał, OPEN)
- PR #43317 — feat/sandbox-provider-interface — PR1 (OPEN)
- PR #43863 — feat/vm-runner-firecracker — PR2, Firecracker (OPEN)

Lokalny openclawA ma 2 niespushowane commity na feat/sandbox-provider-interface (brak upstream).
