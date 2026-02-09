---
summary: "Zautomatyzowana, utwardzona instalacja OpenClaw z użyciem Ansible, VPN Tailscale oraz izolacji zapory"
read_when:
  - Chcesz zautomatyzowanego wdrażania serwerów z utwardzaniem bezpieczeństwa
  - Potrzebujesz konfiguracji izolowanej zaporą z dostępem przez VPN
  - Wdrażasz na zdalnych serwerach Debian/Ubuntu
title: "Ansible"
---

# Instalacja Ansible

Zalecanym sposobem wdrażania OpenClaw na serwerach produkcyjnych jest **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — zautomatyzowany instalator o architekturze „security-first”.

## Szybki start

Instalacja jednym poleceniem:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Pełny przewodnik: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> Repozytorium openclaw-ansible jest źródłem prawdy dla wdrożeń Ansible. Ta strona stanowi szybki przegląd.

## Co otrzymujesz

- 🔒 **Bezpieczeństwo oparte na zaporze**: UFW + izolacja Dockera (dostępne tylko SSH + Tailscale)
- 🔐 **VPN Tailscale**: Bezpieczny zdalny dostęp bez publicznego wystawiania usług
- 🐳 **Docker**: Izolowane kontenery sandbox, wiązania tylko do localhost
- 🛡️ **Obrona warstwowa**: 4‑warstwowa architektura bezpieczeństwa
- 🚀 **Konfiguracja jednym poleceniem**: Pełne wdrożenie w kilka minut
- 🔧 **Integracja z systemd**: Automatyczny start przy uruchomieniu z utwardzaniem

## Wymagania

- **OS**: Debian 11+ lub Ubuntu 20.04+
- **Dostęp**: Uprawnienia root lub sudo
- **Sieć**: Połączenie z Internetem do instalacji pakietów
- **Ansible**: 2.14+ (instalowany automatycznie przez skrypt szybkiego startu)

## Co jest instalowane

Playbook Ansible instaluje i konfiguruje:

1. **Tailscale** (siatkowy VPN do bezpiecznego zdalnego dostępu)
2. **Zapora UFW** (tylko porty SSH + Tailscale)
3. **Docker CE + Compose V2** (dla sandboxów agentów)
4. **Node.js 22.x + pnpm** (zależności środowiska uruchomieniowego)
5. **OpenClaw** (host‑based, niekonteneryzowany)
6. **Usługa systemd** (automatyczny start z utwardzaniem bezpieczeństwa)

Uwaga: Gateway działa **bezpośrednio na hoście** (nie w Dockerze), natomiast sandboxy agentów używają Dockera do izolacji. Zobacz [Sandboxing](/gateway/sandboxing), aby poznać szczegóły.

## Konfiguracja po instalacji

Po zakończeniu instalacji przełącz się na użytkownika openclaw:

```bash
sudo -i -u openclaw
```

Skrypt post‑install poprowadzi Cię przez:

1. **Kreator onboardingu**: Konfigurację ustawień OpenClaw
2. **Logowanie do dostawcy**: Połączenie z WhatsApp/Telegram/Discord/Signal
3. **Testy Gateway**: Weryfikację instalacji
4. **Konfigurację Tailscale**: Połączenie z siatką VPN

### Szybkie polecenia

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## Architektura bezpieczeństwa

### 4-Warstwowa Obrona

1. **Zapora (UFW)**: Publicznie wystawione tylko SSH (22) + Tailscale (41641/udp)
2. **VPN (Tailscale)**: Gateway dostępny wyłącznie przez siatkę VPN
3. **Izolacja Dockera**: Łańcuch iptables DOCKER-USER zapobiega zewnętrznej ekspozycji portów
4. **Utwardzanie systemd**: NoNewPrivileges, PrivateTmp, użytkownik bez uprawnień

### Weryfikacja

Przetestuj zewnętrzną powierzchnię ataku:

```bash
nmap -p- YOUR_SERVER_IP
```

Powinien pokazać **tylko port 22** (SSH) jako otwarty. Wszystkie pozostałe usługi (gateway, Docker) są zablokowane.

### Dostępność Dockera

Docker jest instalowany dla **sandboxów agentów** (izolowane wykonywanie narzędzi), a nie do uruchamiania samego gateway. Gateway wiąże się wyłącznie z localhost i jest dostępny przez VPN Tailscale.

Zobacz [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) w celu konfiguracji sandboxów.

## Instalacja ręczna

Jeśli wolisz ręczną kontrolę zamiast automatyzacji:

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## Aktualizowanie OpenClaw

Instalator Ansible konfiguruje OpenClaw pod kątem ręcznych aktualizacji. Zobacz [Updating](/install/updating), aby poznać standardowy przepływ aktualizacji.

Aby ponownie uruchomić playbook Ansible (np. w celu zmian konfiguracji):

```bash
cd openclaw-ansible
./run-playbook.sh
```

Uwaga: Jest to idempotentne i bezpieczne do wielokrotnego uruchamiania.

## Rozwiązywanie problemów

### Zapora blokuje moje połączenie

Jeśli zostałeś zablokowany:

- Najpierw upewnij się, że masz dostęp przez VPN Tailscale
- Dostęp SSH (port 22) jest zawsze dozwolony
- Gateway jest **wyłącznie** dostępny przez Tailscale zgodnie z założeniami

### Usługa nie uruchamia się

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Problemy z sandboxem Dockera

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### Logowanie do dostawcy nie działa

Upewnij się, że działasz jako użytkownik `openclaw`:

```bash
sudo -i -u openclaw
openclaw channels login
```

## Konfiguracja zaawansowana

Szczegółowa architektura bezpieczeństwa i rozwiązywanie problemów:

- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## Powiązane

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — pełny przewodnik wdrożeniowy
- [Docker](/install/docker) — konteneryzowana konfiguracja gateway
- [Sandboxing](/gateway/sandboxing) — konfiguracja sandboxów agentów
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — izolacja per‑agent
