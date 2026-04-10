# Requirements — v1.0 Security Hardening

## Milestone v1.0 Requirements

### KERN — Kernel Isolation (gVisor + Firecracker)

- [ ] **KERN-01**: System uruchamia kontenery sandbox z gVisor runtime (`--runtime=runsc`) gdy runsc jest zainstalowany na hoście
- [ ] **KERN-02**: GVisorProvider.checkHealth() zwraca `available: true` na Ubuntu z zainstalowanym gVisor
- [ ] **KERN-03**: System automatycznie wykrywa i preferuje gVisor nad Docker (DETECTION_ORDER: ["gvisor", "docker"])
- [ ] **KERN-04**: FirecrackerProvider uruchomiony lokalnie (kod istnieje w PR #43863, wymaga merge + vm-runner setup)
- [ ] **KERN-05**: vm-runner (Go service) działa na Ubuntu i odpowiada na gRPC health check
- [ ] **KERN-06**: DETECTION_ORDER `["firecracker", "gvisor", "docker"]` aktywny — Firecracker wybierany automatycznie gdy `/dev/kvm` dostępne
- [ ] **KERN-07**: Skrypt instalacyjny `scripts/install-gvisor.sh` instaluje runsc na Ubuntu/Debian

### CAP — Capability Hardening

- [ ] **CAP-01**: Kontenery sandbox startują z `--cap-drop=ALL` zamiast selektywnego drop NET_RAW/NET_ADMIN
- [ ] **CAP-02**: NET_ADMIN capability jest dodawane selektywnie tylko gdy SSRF defense (iptables) jest włączone
- [ ] **CAP-03**: docker-compose.yml aktualizuje cap_drop dla gateway i CLI serwisów na ALL
- [ ] **CAP-04**: Testy jednostkowe pokrywają weryfikację że buildSandboxCreateArgs() generuje --cap-drop=ALL

### OUT — Output Sanitization

- [ ] **OUT-01**: Output sandbox kontenera jest skanowany przed zwróceniem do agenta
- [ ] **OUT-02**: Scanner wykrywa prompt injection (10 wzorców: "ignore previous instructions", `<system>`, ChatML, DAN)
- [ ] **OUT-03**: Scanner wykrywa wyciek sekretów (OpenAI/Anthropic/AWS/GitHub/JWT/PEM key patterns)
- [ ] **OUT-04**: Scanner wykrywa ANSI escape sequences (CSI, OSC, C0/C1) i je usuwa
- [ ] **OUT-05**: Scanner wykrywa hidden Unicode (zero-width chars, RTL override)
- [ ] **OUT-06**: Scanner wykrywa data exfiltration patterns (base64, curl/wget/fetch, IP/URL)
- [ ] **OUT-07**: Critical findings blokują output i zwracają błąd do agenta
- [ ] **OUT-08**: High findings sanitizują output (redact) zamiast blokować całkowicie
- [ ] **OUT-09**: Implementacja reużywa kodu z `/Users/jakubkarwowski/projekty/sandbox-local/src/output-scanner.mjs` lub portuje go do TypeScript

### NET — Network & Proxmox Isolation

- [ ] **NET-01**: Dokumentacja zawiera schemat topologii sieciowej: Proxmox → Ubuntu VM → Docker → kontenery
- [ ] **NET-02**: Skrypt `scripts/proxmox-firewall.sh` konfiguruje reguły Proxmox blokujące Ubuntu VM → port 8006 (Proxmox management)
- [ ] **NET-03**: Skrypt zawiera instrukcje konfiguracji VLAN dla izolacji Ubuntu VM od sieci management
- [ ] **NET-04**: Weryfikacja że inne VM na Proxmox nie są dostępne z poziomu kontenera sandbox (test przez sieć Docker bridge)

### PIPE — Pipeline Integration (sandbox-local → openclawA)

- [ ] **PIPE-01**: Static analysis (regex 21 wzorców) uruchamiany na kodzie przed exec() w sandbox
- [ ] **PIPE-02**: Audit log zapisuje każdy exec() z kodem, wynikiem skanowania i statusem do struktury logów openclawA
- [ ] **PIPE-03**: Human review hook (opcjonalny) jest wywoływany dla `high` severity findings przed exec()

---

## Future Requirements (v2.0+)

- Kata Containers backend jako alternatywa dla Firecracker
- Seccomp custom profile (zamiast domyślnego Docker)
- AppArmor custom profile dla sandbox kontenerów
- Output scanner dla formatu binarnego (nie tylko text)
- Distributed audit log (zamiast lokalnego SQLite)

---

## Out of Scope (v1.0)

- **Kubernetes deployment** — single-node setup, orchestration nadmiarowy
- **SELinux** — Ubuntu używa AppArmor; migracja nie jest uzasadniona
- **Rootless Docker** — kompatybilność z istniejącym setupem ważniejsza
- **Network egress filtering poza metadata endpoints** — nie jest w scope threat modelu
- **Custom seccomp profiles** — domyślny Docker seccomp wystarczy dla v1.0

---

## Traceability

| REQ-ID  | Phase   | Status |
| ------- | ------- | ------ |
| KERN-01 | Phase 1 | —      |
| KERN-02 | Phase 1 | —      |
| KERN-03 | Phase 1 | —      |
| KERN-07 | Phase 1 | —      |
| CAP-01  | Phase 2 | —      |
| CAP-02  | Phase 2 | —      |
| CAP-03  | Phase 2 | —      |
| CAP-04  | Phase 2 | —      |
| KERN-04 | Phase 3 | —      |
| KERN-05 | Phase 3 | —      |
| KERN-06 | Phase 3 | —      |
| OUT-01  | Phase 4 | —      |
| OUT-02  | Phase 4 | —      |
| OUT-03  | Phase 4 | —      |
| OUT-04  | Phase 4 | —      |
| OUT-05  | Phase 4 | —      |
| OUT-06  | Phase 4 | —      |
| OUT-07  | Phase 4 | —      |
| OUT-08  | Phase 4 | —      |
| OUT-09  | Phase 4 | —      |
| NET-01  | Phase 5 | —      |
| NET-02  | Phase 5 | —      |
| NET-03  | Phase 5 | —      |
| NET-04  | Phase 5 | —      |
| PIPE-01 | Phase 6 | —      |
| PIPE-02 | Phase 6 | —      |
| PIPE-03 | Phase 6 | —      |
