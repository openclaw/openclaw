# OpenClaw — Security Hardening

## What This Is

OpenClaw to platforma agentów AI z wbudowanym systemem sandboxowania kodu wykonywanego przez modele językowe. Uruchomiona w konfiguracji Proxmox → Ubuntu Server → Docker, obsługuje wielowarstwową izolację przez Docker i gVisor. Projekt używany lokalnie do bezpiecznego uruchamiania agentów AI z dostępem do narzędzi i kodu.

## Core Value

Agent AI nie może uciec z sandboxa i przejąć kontroli nad hostem Ubuntu ani dostać się do innych VM na Proxmox.

## Requirements

### Validated

- ✓ Docker provider z hardeningiem (--read-only, --cap-drop NET_RAW/NET_ADMIN, no-new-privileges) — v0.x
- ✓ gVisor provider (GVisorProvider) zaimplementowany w kodzie — v0.x
- ✓ SSRF defense via iptables (blokada 169.254.169.254, fd00:ec2::254, 100.100.100.200) — v0.x
- ✓ Secret filtering (AWS*\*, ANTHROPIC*_, TOKEN_, SECRET\*) z ENV kontenerów — v0.x
- ✓ Walidacja bind-mountów (denylist: /etc, /proc, /sys, /dev, /root, /var/run/docker.sock) — v0.x
- ✓ Browser security (blokada file:, javascript:, private IP ranges) — v0.x
- ✓ Resource limits (domyślnie: 1 CPU, 512MB RAM, 256 PID) — v0.x
- ✓ Blokada network: host i container:\* namespace join — v0.x
- ✓ 6-warstwowy pipeline w sandbox-local (Static Analysis + Docker/E2B + Output Scanner + Audit log) — v0.x (sandbox-local)

### Active

- [ ] Aktywacja gVisor (runsc) na Ubuntu — zainstalowanie i konfiguracja runsc
- [ ] Firecracker backend (FirecrackerProvider) — zadeklarowany w kodzie jako PR2, niezaimplementowany
- [ ] cap_drop ALL zamiast tylko NET_RAW/NET_ADMIN
- [ ] Output sanitization w openclawA (brakująca warstwa z pipeline sandbox-local)
- [ ] Izolacja sieciowa Ubuntu od Proxmox management interface
- [ ] Integracja output scannera sandbox-local z openclawA
- [ ] Dokumentacja topologii sieciowej i threat model dla konfiguracji Proxmox→Ubuntu→OpenClaw

### Out of Scope

- Kata Containers — brak potrzeby (gVisor + Firecracker wystarczą)
- Kubernetes/orchestration — nadmiarowość dla single-node setup
- SELinux — Ubuntu używa AppArmor, SELinux wymagałby migracji distro
- Rootless Docker — Podman używany osobno, Docker pozostaje z rootem dla kompatybilności

## Context

**Konfiguracja deploymentu:**

```
Proxmox hypervisor
  └── Ubuntu Server VM (host Docker)
        └── Docker Engine
              ├── OpenClaw gateway container
              ├── OpenClaw CLI container
              └── Sandbox containers (agents)
                    ├── Backend: Docker (default)
                    ├── Backend: gVisor --runtime=runsc (TARGET)
                    └── Backend: Firecracker microVM (PLANNED)
```

**Zidentyfikowane luki bezpieczeństwa (audyt 2026-04-10):**

1. gVisor zainstalowany w kodzie ale NIE na Ubuntu — kontenery używają wspólnego kernela
2. cap_drop niekompletne — tylko NET_RAW i NET_ADMIN zamiast ALL
3. Brak output sanitization w openclawA (jest w sandbox-local, brak integracji)
4. Ubuntu VM ma potencjalny dostęp sieciowy do Proxmox management (port 8006)
5. Firecracker backend to throw new Error("PR2") — niezaimplementowany

**Istniejące projekty powiązane:**

- `/Users/jakubkarwowski/projekty/openclawA` — główny projekt
- `/Users/jakubkarwowski/projekty/sandbox-local` — osobna implementacja 6-warstwowego pipeline

**Threat model (z ATLAS):**

- T-EXEC-001: Direct Prompt Injection → CRITICAL
- T-EXEC-002: Indirect Prompt Injection → HIGH
- T-IMPACT-001: Unauthorized Command Execution → CRITICAL
- Container escape via kernel CVE → HIGH (bez gVisor)

## Constraints

- **Tech**: Node.js + TypeScript (openclawA), Docker Engine na Ubuntu — zmiana backendu musi być kompatybilna
- **Runtime**: gVisor wymaga instalacji runsc na hoście Ubuntu (apt package lub binary)
- **Firecracker**: wymaga KVM (/dev/kvm) dostępnego w Ubuntu VM — zależy od konfiguracji Proxmox
- **Network**: zmiany izolacji sieciowej (VLAN, firewall) wymagają dostępu do Proxmox admin
- **Kompatybilność**: gVisor nie obsługuje wszystkich syscalli — część obrazów może nie działać z runsc

## Key Decisions

| Decision                                   | Rationale                                                                             | Outcome   |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | --------- |
| Docker jako fallback po gVisor             | Auto-detection: gVisor > Docker, backwards-compatible                                 | — Pending |
| cap_drop ALL + selektywny cap_add          | Zasada least privilege — dropuj wszystko, dodaj tylko co trzeba                       | — Pending |
| Integracja output scannera z sandbox-local | DRY — nie duplikuj kodu, użyj sprawdzonego scannera                                   | — Pending |
| Firecracker jako najsilniejszy backend     | Pełna VM izolacja z własnym kernelem, Firecracker DETECT_ORDER = gvisor → firecracker | — Pending |
| VLAN izolacja Ubuntu od Proxmox mgmt       | Ograniczenie blast radius przy container escape na Ubuntu                             | — Pending |

## Current Milestone: v1.0 — Security Hardening

**Goal:** Zamknąć zidentyfikowane luki bezpieczeństwa: aktywować gVisor, zaimplementować Firecracker backend, naprawić cap_drop, dodać output sanitization, i odizolować sieciowo Ubuntu od Proxmox.

**Target features:**

- Aktywacja gVisor (runsc) na Ubuntu + weryfikacja health check
- Firecracker microVM backend (FirecrackerProvider)
- cap_drop ALL w kontenerach sandbox
- Output sanitization layer (portowana z sandbox-local)
- Dokumentacja + skrypt konfiguracji sieci Proxmox

---

_Last updated: 2026-04-10 — Milestone v1.0 Security Hardening started_
