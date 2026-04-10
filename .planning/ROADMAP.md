# Roadmap — v1.0 Security Hardening

## Overview

**6 phases** | **27 requirements mapped** | Coverage: 100% ✓

Każda faza zamyka konkretną warstwę ochrony. Kolejność: kernel isolation (najważniejszy) → capability hardening → output sanitization → network isolation → pipeline integration.

| #   | Phase                                     | Goal                                                                       | Requirements        | Success Criteria |
| --- | ----------------------------------------- | -------------------------------------------------------------------------- | ------------------- | ---------------- |
| 1   | gVisor Activation                         | Uruchomić kontenery sandbox z izolacją kernela                             | KERN-01, 02, 03, 07 | 4                |
| 2   | Capability Hardening                      | cap_drop ALL w każdym kontenerze sandbox                                   | CAP-01, 02, 03, 04  | 3                |
| 3   | ~~Firecracker Backend~~ → Merge PR #43863 | Uruchomić vm-runner + FirecrackerProvider lokalnie (kod już istnieje w PR) | KERN-04, 05, 06     | 4                |
| 4   | Output Sanitization                       | Skanowanie outputu sandboxa przed zwróceniem do agenta                     | OUT-01..09          | 5                |
| 5   | Network Isolation                         | Odizolować Ubuntu od Proxmox management                                    | NET-01, 02, 03, 04  | 3                |
| 6   | Pipeline Integration                      | Static analysis + audit log z sandbox-local                                | PIPE-01, 02, 03     | 3                |

---

## Phase Details

---

### Phase 1: gVisor Activation

**Goal:** Kontenery sandbox uruchamiają się z gVisor runtime (`--runtime=runsc`), izolując kernel Ubuntu od procesów agenta.

**Requirements:** KERN-01, KERN-02, KERN-03, KERN-07

**Why first:** Najważniejsza luka — bez gVisor każdy kernel CVE pozwala na container escape. Reszta hardening jest bez sensu jeśli kontener dzieli kernel z hostem.

**Tasks:**

1. Napisz `scripts/install-gvisor.sh` — instalacja runsc z oficjalnego repo Google na Ubuntu/Debian
2. Dodaj runsc do konfiguracji Docker daemon (`/etc/docker/daemon.json`, `"runtimes": {"runsc": {...}}`)
3. Zweryfikuj `GVisorProvider.checkHealth()` — Stage 1 (docker info runtimes) + Stage 2 (run hello-world)
4. Przetestuj DETECTION_ORDER: gdy runsc dostępny → gVisor wybrany automatycznie
5. Dodaj test integracyjny `tests/sandbox/gvisor-health.test.ts`

**Success Criteria:**

1. `docker info | grep runsc` zwraca wynik na Ubuntu
2. `GVisorProvider.checkHealth()` → `{ available: true }`
3. `resolveProvider("auto")` → GVisorProvider (nie DockerProvider) gdy runsc zainstalowany
4. Kontener `openclaw-gvisor-*` uruchamia się z `--runtime=runsc` (widoczne w `docker inspect`)

**Dependencies:** Dostęp SSH do Ubuntu Server, Docker daemon restart

**Risks:**

- Nie wszystkie obrazy kompatybilne z gVisor (syscall coverage) — weryfikować z `sandbox` obrazem
- KVM wymagane dla gVisor na niektórych platformach — Proxmox może blokować nested virt

---

### Phase 2: Capability Hardening

**Goal:** Każdy kontener sandbox startuje z `--cap-drop=ALL` i tylko niezbędnymi capabilities selektywnie dodanymi.

**Requirements:** CAP-01, CAP-02, CAP-03, CAP-04

**Why second:** Szybka wygrana po gVisor. Zmiana 2 linii w docker-compose.yml i buildSandboxCreateArgs(). Zmniejsza attack surface nawet przy Docker (bez gVisor).

**Tasks:**

1. Zmień `docker-compose.yml`: `cap_drop: [ALL]` dla `openclaw-gateway` i `openclaw-cli`
2. Zmień `buildSandboxCreateArgs()` w `src/agents/sandbox/docker.ts`: domyślnie `--cap-drop=ALL`
3. Dodaj `--cap-add=NET_ADMIN` selektywnie tylko gdy `applyMetadataEgressBlock` jest włączone
4. Zaktualizuj `DEFAULT_RESOURCE_LIMITS` — dodaj pole `capDrop: ["ALL"]`
5. Dodaj test jednostkowy weryfikujący że `buildSandboxCreateArgs()` zawiera `--cap-drop=ALL`

**Success Criteria:**

1. `docker inspect <sandbox>` → `CapDrop` zawiera `0x3fffffffff` (ALL)
2. `docker inspect <sandbox>` → `CapAdd` zawiera tylko `NET_ADMIN` (gdy iptables włączone) lub puste
3. Test `cap-drop.test.ts` przechodzi
4. Istniejące testy (bash-tools.build-docker-exec-args.test.ts) nie regresują

**Dependencies:** Phase 1 (wiedza o NET_ADMIN requirement dla iptables)

---

### Phase 3: Merge PR #43863 — vm-runner + Firecracker lokalnie

> **UWAGA:** Implementacja już istnieje. PR #43863 (`jamtujest:feat/vm-runner-firecracker`) na `openclaw/openclaw`
> zawiera pełny FirecrackerProvider + Go vm-runner service. Ta faza = merge + uruchomienie lokalne.

**Goal:** Uruchomić istniejący kod Firecracker z PR #43863 na lokalnym Ubuntu, w tym Go vm-runner service.

**Requirements:** KERN-04, KERN-05, KERN-06

**Co już istnieje w PR #43863:**

- `src/agents/sandbox/providers/firecracker-provider.ts` — FirecrackerProvider (ISandboxProvider)
- `src/agents/sandbox/grpc/` — TypeScript gRPC client (channel, middleware, health)
- `openclaw-vm-runner/` — Go serwis: SandboxService, BrowserService, Snapshot Pool, jailer
- `proto/` — Protobuf (envd + sandbox services, buf-managed)
- DETECTION_ORDER zaktualizowany: `["firecracker", "gvisor", "docker"]`
- `docs/sandbox-providers.md` — pełna dokumentacja architektury

**Tasks:**

1. Sprawdź status PR #43863 — czy jest gotowy do merge (review, CI)
2. Zrebase lokalnie: pobierz branch `feat/vm-runner-firecracker` z fork remote do `openclaw-repo`
3. Sprawdź `/dev/kvm` na Ubuntu: `ls -la /dev/kvm` — jeśli brak, włącz KVM pass-through w Proxmox (`Hardware → Processors → Type: host`)
4. Zainstaluj zależności Go vm-runner: `cd openclaw-vm-runner && go build ./...`
5. Zainstaluj Firecracker binary + jailer na Ubuntu
6. Uruchom vm-runner: `./openclaw-vm-runner` i zweryfikuj gRPC health check
7. Przetestuj `resolveProvider("auto")` — powinien zwrócić FirecrackerProvider

**Success Criteria:**

1. `FirecrackerProvider.checkHealth()` → `{ available: true }` na Ubuntu z KVM
2. `resolveProvider("auto")` → FirecrackerProvider (najwyższy priorytet w DETECTION_ORDER)
3. Agent wykonuje `exec()` w Firecracker microVM — vm-runner loguje aktywność
4. Graceful degradation: gdy `/dev/kvm` niedostępne → gVisor (nie crash)

**Dependencies:**

- `/dev/kvm` na Ubuntu VM (wymaga konfiguracji Proxmox: `cpu: host` lub `kvm=1`)
- Go 1.21+ na Ubuntu do budowania vm-runner
- Firecracker binary + jailer (dostępne z GitHub releases)

**Risks:**

- Proxmox może blokować KVM dla VM — wymaga ręcznej zmiany w Proxmox admin
- PR #43863 może mieć konflikty z main (jest OPEN od marca 2026)
- vm-runner wymaga rootfs image dla microVM — sprawdź czy jest w repo

---

### Phase 4: Output Sanitization

**Goal:** Każdy output z sandboxa jest skanowany pod kątem prompt injection, wycieków sekretów, ANSI escapes i data exfiltration przed zwróceniem do agenta.

**Requirements:** OUT-01 do OUT-09

**Why fourth:** Brakująca warstwa w openclawA (jest w sandbox-local, brak w openclawA). Zapobiega atakom przez złośliwy output (Terminal DiLLMa, prompt injection przez stdout).

**Tasks:**

1. Port lub import `output-scanner.mjs` z sandbox-local do TypeScript (`src/agents/sandbox/hardening/output-sanitizer.ts`)
2. Zaimplementuj `scanOutput(stdout, stderr)` → `{ findings: Finding[], blocked: boolean, sanitized: string }`
3. Dodaj wywołanie `scanOutput()` w `DockerProvider.exec()` i `GVisorProvider.exec()` przed zwróceniem wyniku
4. Zaimplementuj `sanitizeOutput()` — strip ANSI, redact secrets, usuń hidden Unicode
5. Critical findings → throw SandboxOutputBlockedError
6. High findings → sanitize + log warning (nie blokuj)
7. Dodaj testy jednostkowe (port 60 testów z sandbox-local do TypeScript)

**Output Scanner Categories:**

```typescript
// Port z sandbox-local/src/output-scanner.mjs
- promptInjection: 10 wzorców ("ignore previous", <system>, ChatML, DAN, LLM markers)
- secrets: 14 wzorców (OpenAI/Anthropic/AWS/GitHub/Slack/Stripe, JWT, PEM, connection strings)
- ansiEscapes: CSI, OSC, C0/C1 sequences
- hiddenUnicode: zero-width chars (U+200B..U+200F), RTL override (U+202A..U+202E)
- dataExfil: URL patterns, IP, base64, curl/wget/fetch commands
- base64Decode: rekurencyjne dekodowanie i re-skanowanie zawartości
```

**Success Criteria:**

1. `exec()` z outputem zawierającym "ignore previous instructions" → throws SandboxOutputBlockedError
2. `exec()` z outputem zawierającym ANSI escapes → output sanitized (sequences usunięte)
3. `exec()` z outputem zawierającym OpenAI key pattern → redacted w wyniku
4. Czyste outputy (JSON, tekst, liczby) przechodzą bez modyfikacji
5. 60+ testów jednostkowych przechodzi

**Dependencies:** Phase 1 (providers muszą istnieć żeby podłączyć scanner do exec())

---

### Phase 5: Network & Proxmox Isolation

**Goal:** Ubuntu VM jest odizolowana sieciowo od Proxmox management interface, ograniczając blast radius przy container escape.

**Requirements:** NET-01, NET-02, NET-03, NET-04

**Why fifth:** Zmiana infrastrukturalna (wymaga dostępu Proxmox admin). Nie zmienia kodu openclawA — to konfiguracja sieci i dokumentacja.

**Tasks:**

1. Utwórz `docs/security/NETWORK-TOPOLOGY.md` — schemat ASCII topologii sieciowej
2. Utwórz `scripts/proxmox-firewall.sh` — reguły Proxmox Firewall (pvefw) blokujące:
   - Ubuntu VM → Proxmox management (port 8006/tcp)
   - Ubuntu VM → inne VM (opcjonalnie, przez VLAN)
3. Opisz konfigurację VLAN w Proxmox dla izolacji management network
4. Utwórz `scripts/verify-network-isolation.sh` — skrypt testujący izolację:
   - Z kontenera sandbox: `curl --connect-timeout 2 http://<proxmox-ip>:8006` → connection refused
   - Z Ubuntu hosta: `nc -zv <proxmox-ip> 8006` → wynik zależy od konfiguracji
5. Aktualizuj `docs/security/THREAT-MODEL-ATLAS.md` — dodaj Proxmox pivot jako threat

**Network Topology (dokumentować):**

```
[Internet]
    │
[Proxmox node] ── management network (VLAN 1)
    │                  └── Proxmox web UI :8006
    ├── [VM: Ubuntu Server] ── production network (VLAN 100)
    │       └── Docker Engine
    │             ├── openclaw-gateway (bridge: openclaw_net)
    │             └── sandbox containers (bridge: openclaw_sandbox)
    └── [VM: other VMs] ── isolated network (VLAN 200)

REGUŁA: VLAN 100 nie ma routingu do VLAN 1 (management)
```

**Success Criteria:**

1. `NETWORK-TOPOLOGY.md` zawiera pełny schemat z VLAN assignments
2. `proxmox-firewall.sh` zawiera gotowe komendy pvefw do wklejenia
3. Z poziomu kontenera sandbox nie można dosięgnąć Proxmox :8006
4. Dokumentacja zawiera instrukcję weryfikacji izolacji

**Dependencies:** Dostęp do Proxmox admin panel (ręczna konfiguracja VLAN/firewall przez użytkownika)

---

### Phase 6: Pipeline Integration

**Goal:** Kod wykonywany w sandboxie przechodzi przez static analysis przed exec(), a każdy exec jest logowany do audit logu.

**Requirements:** PIPE-01, PIPE-02, PIPE-03

**Why last:** Uzupełnienie pipeline z sandbox-local. Fazy 1-5 zamykają luki bezpieczeństwa; ta faza dodaje visibility i pre-execution scanning.

**Tasks:**

1. Port `static-analysis.py` (Python AST scanner) do obrazu Docker sandbox — już jest w sandbox-local
2. Zaimplementuj `scanInput(code, language)` w TypeScript jako wrapper wywołujący statyczny scanner
3. Wywołaj `scanInput()` w `exec()` przed uruchomieniem kodu:
   - `critical` → throw SandboxInputBlockedError (nie wykonuj kodu)
   - `high` + `humanReview: true` → wywołaj hook, czekaj na decyzję
4. Zaimplementuj `AuditLog` w openclawA (`src/agents/sandbox/audit-log.ts`):
   - Loguj każdy exec(): kod, wynik scanInput, wynik scanOutput, blocked/passed, czas
   - Backend: JSON lines do pliku (nie SQLite — prostsze dla openclawA)
5. Dodaj `humanReview` hook do `EnsureSandboxParams` / `ExecOptions`

**Pre-execution Scanner Patterns (21 wzorców z sandbox-local):**

```
Python: os.system(), subprocess.run/call/check_output, shutil.rmtree, exec()/eval(), import socket
Sandbox escape: docker.sock mount, nsenter, reverse shell (bash -i, nc -e), /proc escape, cgroup write, mount syscall
Node.js: child_process.exec/spawn, fs.rmSync/unlinkSync
```

**Success Criteria:**

1. `exec()` z kodem `import os; os.system("id")` → throws SandboxInputBlockedError (critical)
2. `exec()` z podejrzanym kodem (high) + `humanReview: true` → pauza + pytanie do użytkownika
3. Każdy exec() generuje wpis w audit log (blocked i passed)
4. Audit log zawiera pełny kod, findings i timestamp

**Dependencies:** Phase 4 (output scanner infrastructure do reużycia), Phase 1-3 (providers)

---

## Milestones

### v0.x — Baseline (shipped)

Fazy 1-6 powyżej = v1.0. Poprzedni stan to v0.x baseline z Docker+gVisor w kodzie (bez aktywacji).

### v1.0 — Security Hardening (this milestone)

Phases 1-6 powyżej. Target: zamknięcie wszystkich zidentyfikowanych luk z audytu 2026-04-10.

### v2.0 — Future

- Custom seccomp profiles
- AppArmor profiles per-agent
- Distributed audit log
- Kata Containers backend
