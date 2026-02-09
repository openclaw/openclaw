---
summary: "OpenClaw na Oracle Cloud (Always Free ARM)"
read_when:
  - Konfiguracja OpenClaw na Oracle Cloud
  - Poszukiwanie taniego hostingu VPS dla OpenClaw
  - Chęć uruchomienia OpenClaw 24/7 na małym serwerze
title: "Oracle Cloud"
---

# OpenClaw na Oracle Cloud (OCI)

## Cel

Uruchomienie trwałego Gateway OpenClaw na warstwie **Always Free** ARM w Oracle Cloud.

Darmowa warstwa Oracle może być świetnym wyborem dla OpenClaw (zwłaszcza jeśli masz już konto OCI), ale wiąże się z pewnymi kompromisami:

- Architektura ARM (większość rzeczy działa, ale niektóre binaria mogą być dostępne tylko dla x86)
- Pojemność i proces rejestracji bywają kapryśne

## Porównanie kosztów (2026)

| Dostawca     | Plan            | Specyfikacja         | Cena/m2              | Uwagi                        |
| ------------ | --------------- | -------------------- | -------------------- | ---------------------------- |
| Oracle Cloud | Always Free ARM | do 4 OCPU, 24 GB RAM | $0                   | ARM, ograniczona pojemność   |
| Hetzner      | CX22            | 2 vCPU, 4 GB RAM     | ~ $4 | Najtańsza opcja płatna       |
| DigitalOcean | Basic           | 1 vCPU, 1 GB RAM     | $6                   | Prosty interfejs, dobre docs |
| Vultr        | Cloud Compute   | 1 vCPU, 1 GB RAM     | $6                   | Wiele lokalizacji            |
| Linode       | Nanode          | 1 vCPU, 1 GB RAM     | $5                   | Obecnie część Akamai         |

---

## Wymagania wstępne

- Konto Oracle Cloud ([rejestracja](https://www.oracle.com/cloud/free/)) — zobacz [poradnik społeczności](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd), jeśli napotkasz problemy
- Konto Tailscale (darmowe na [tailscale.com](https://tailscale.com))
- ~30 minut

## 1. Utwórz instancję OCI

1. Zaloguj się do [Oracle Cloud Console](https://cloud.oracle.com/)
2. Przejdź do **Compute → Instances → Create Instance**
3. Skonfiguruj:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (lub do 4)
   - **Memory:** 12 GB (lub do 24 GB)
   - **Boot volume:** 50 GB (do 200 GB za darmo)
   - **SSH key:** Dodaj swój klucz publiczny
4. Kliknij **Create**
5. Zanotuj publiczny adres IP

**Wskazówka:** Jeśli tworzenie instancji kończy się błędem „Out of capacity”, spróbuj innej domeny dostępności lub ponów próbę później. Pojemność darmowej warstwy jest ograniczona.

## 2. Połącz się i zaktualizuj

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Uwaga:** `build-essential` jest wymagane do kompilacji ARM niektórych zależności.

## 3. Skonfiguruj użytkownika i nazwę hosta

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Zainstaluj Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Umożliwia to SSH przez Tailscale, dzięki czemu możesz łączyć się przez `ssh openclaw` z dowolnego urządzenia w swojej sieci tailnet — bez potrzeby publicznego IP.

Sprawdź:

```bash
tailscale status
```

**Od teraz łącz się przez Tailscale:** `ssh ubuntu@openclaw` (lub użyj adresu IP Tailscale).

## 5. Zainstaluj OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

Gdy pojawi się pytanie „How do you want to hatch your bot?”, wybierz **„Do this later”**.

> Uwaga: Jeśli napotkasz problemy z natywną kompilacją ARM, zacznij od pakietów systemowych (np. `sudo apt install -y build-essential`), zanim sięgniesz po Homebrew.

## 6. Skonfiguruj Gateway (loopback + uwierzytelnianie tokenem) i włącz Tailscale Serve

Używaj uwierzytelniania tokenem jako domyślnego. Jest przewidywalne i pozwala uniknąć konieczności ustawiania jakichkolwiek flag „insecure auth” w Control UI.

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7. Weryfikacja

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8. Zablokuj zabezpieczenia VCN

Gdy wszystko już działa, zablokuj VCN, aby zablokować cały ruch poza Tailscale. Virtual Cloud Network OCI działa jak zapora na krawędzi sieci — ruch jest blokowany, zanim dotrze do instancji.

1. Przejdź do **Networking → Virtual Cloud Networks** w konsoli OCI
2. Kliknij swój VCN → **Security Lists** → Default Security List
3. **Usuń** wszystkie reguły ingress poza:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Zachowaj domyślne reguły egress (zezwól na cały ruch wychodzący)

To blokuje SSH na porcie 22, HTTP, HTTPS oraz wszystko inne na krawędzi sieci. Od teraz możesz łączyć się wyłącznie przez Tailscale.

---

## Dostęp do Control UI

Z dowolnego urządzenia w Twojej sieci Tailscale:

```
https://openclaw.<tailnet-name>.ts.net/
```

Zastąp `<tailnet-name>` nazwą swojej sieci tailnet (widoczną w `tailscale status`).

Nie jest wymagany tunel SSH. Tailscale zapewnia:

- Szyfrowanie HTTPS (automatyczne certyfikaty)
- Uwierzytelnianie poprzez tożsamość Tailscale
- Dostęp z dowolnego urządzenia w Twojej sieci tailnet (laptop, telefon itd.)

---

## Bezpieczeństwo: VCN + Tailscale (zalecana baza)

Przy zablokowanym VCN (otwarty tylko UDP 41641) i Gateway powiązanym z loopback, otrzymujesz solidną obronę warstwową: ruch publiczny jest blokowany na krawędzi sieci, a dostęp administracyjny odbywa się przez Twoją sieć tailnet.

Ta konfiguracja często eliminuje _potrzebę_ dodatkowych reguł zapory na hoście wyłącznie w celu zatrzymania ataków brute force SSH z Internetu — nadal jednak należy utrzymywać system w aktualnym stanie, uruchamiać `openclaw security audit` i weryfikować, że nic nie nasłuchuje przypadkowo na publicznych interfejsach.

### Co jest już chronione

| Tradycyjny krok           | Wymagany?  | Dlaczego                                                                          |
| ------------------------- | ---------- | --------------------------------------------------------------------------------- |
| UFW firewall              | Nie        | VCN blokuje ruch, zanim dotrze do instancji                                       |
| fail2ban                  | Nie        | Brak brute force, jeśli port 22 jest zablokowany na poziomie VCN                  |
| Utwardzanie sshd          | Nie        | SSH Tailscale nie korzysta z sshd                                                 |
| Wyłączenie logowania root | Nie        | Tailscale używa tożsamości Tailscale, a nie użytkowników systemowych              |
| Tylko klucze SSH          | Nie        | Tailscale uwierzytelnia przez Twoją sieć tailnet                                  |
| Utwardzanie IPv6          | Zwykle nie | Zależy od ustawień VCN/podsieci; sprawdź, co faktycznie jest przypisane/ujawnione |

### Nadal zalecane

- **Uprawnienia do poświadczeń:** `chmod 700 ~/.openclaw`
- **Audyt bezpieczeństwa:** `openclaw security audit`
- **Aktualizacje systemu:** regularnie `sudo apt update && sudo apt upgrade`
- **Monitorowanie Tailscale:** przeglądaj urządzenia w [konsoli administracyjnej Tailscale](https://login.tailscale.com/admin)

### Weryfikacja postawy bezpieczeństwa

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Alternatywa: tunel SSH

Jeśli Tailscale Serve nie działa, użyj tunelu SSH:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Następnie otwórz `http://localhost:18789`.

---

## Rozwiązywanie problemów

### Tworzenie instancji kończy się niepowodzeniem („Out of capacity”)

Darmowe instancje ARM są popularne. Spróbuj:

- Innej domeny dostępności
- Ponowienia próby poza godzinami szczytu (wczesny poranek)
- Użycia filtra „Always Free” podczas wyboru kształtu

### Tailscale nie łączy się

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway nie uruchamia się

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Brak dostępu do Control UI

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### Problemy z binariami ARM

Niektóre narzędzia mogą nie mieć wersji ARM. Sprawdź:

```bash
uname -m  # Should show aarch64
```

Większość pakietów npm działa bez problemu. W przypadku binariów szukaj wydań `linux-arm64` lub `aarch64`.

---

## Trwałość

Cały stan znajduje się w:

- `~/.openclaw/` — konfiguracja, poświadczenia, dane sesji
- `~/.openclaw/workspace/` — obszar roboczy (SOUL.md, pamięć, artefakty)

Wykonuj okresowe kopie zapasowe:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Zobacz także

- [Zdalny dostęp do Gateway](/gateway/remote) — inne wzorce zdalnego dostępu
- [Integracja Tailscale](/gateway/tailscale) — pełna dokumentacja Tailscale
- [Konfiguracja Gateway](/gateway/configuration) — wszystkie opcje konfiguracji
- [Poradnik DigitalOcean](/platforms/digitalocean) — jeśli chcesz płatną opcję z łatwiejszą rejestracją
- [Poradnik Hetzner](/install/hetzner) — alternatywa oparta na Dockerze
