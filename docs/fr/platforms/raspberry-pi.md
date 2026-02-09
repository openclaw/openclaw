---
summary: "OpenClaw sur Raspberry Pi (installation auto-hébergée à petit budget)"
read_when:
  - Mise en place d'OpenClaw sur un Raspberry Pi
  - Exécution d'OpenClaw sur des appareils ARM
  - Construction d'une IA personnelle toujours active et peu coûteuse
title: "Raspberry Pi"
---

# OpenClaw sur Raspberry Pi

## Objectif

Exécuter une Gateway (passerelle) OpenClaw persistante, toujours active, sur un Raspberry Pi pour un **coût unique d’environ 35–80 $** (sans frais mensuels).

Parfait pour :

- Assistant IA personnel 24/7
- Centre d'automatisation de la maison
- Bot Telegram/WhatsApp basse consommation et toujours disponible

## Exigences matérielles

| Modèle Pi       | RAM     | Fonctionne ?      | Notes                                                  |
| --------------- | ------- | ----------------- | ------------------------------------------------------ |
| **Pi 5**        | 4GB/8GB | ✅ Meilleur        | Le plus rapide, recommandé                             |
| **Pi 4**        | 4GB     | ✅ Bon             | Le meilleur compromis pour la plupart des utilisateurs |
| **Pi 4**        | 2GB     | ✅ OK              | Fonctionne, ajouter du swap                            |
| **Pi 4**        | 1GB     | ⚠️ Tight          | Possible avec swap, config minimale                    |
| **Pi 3B+**      | 1GB     | ⚠️ Ralentissement | Fonctionne mais peu réactif                            |
| **Pi Zero 2 W** | 512MB   | ❌                 | Non recommandé                                         |

**Spécifications minimales :** 1GB de RAM, 1 cœur, 500MB de disque  
**Recommandé :** 2GB+ de RAM, OS 64 bits, carte SD de 16GB+ (ou SSD USB)

## Ce dont vous aurez besoin

- Raspberry Pi 4 ou 5 (2GB+ recommandé)
- Carte microSD (16GB+) ou SSD USB (meilleures performances)
- Alimentation (PSU officielle Pi recommandée)
- Connexion réseau (Ethernet ou WiFi)
- ~30 minutes

## 1. Flasher l’OS

Utilisez **Raspberry Pi OS Lite (64-bit)** — aucun environnement de bureau nécessaire pour un serveur headless.

1. Téléchargez [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Choisissez l’OS : **Raspberry Pi OS Lite (64-bit)**
3. Cliquez sur l’icône engrenage (⚙️) pour préconfigurer :
   - Définir le nom d’hôte : `gateway-host`
   - Activer SSH
   - Définir le nom d’utilisateur/mot de passe
   - Configurer le WiFi (si vous n’utilisez pas Ethernet)
4. Flashez sur votre carte SD / disque USB
5. Insérez et démarrez le Pi

## 2) Connexion via SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. Configuration du système

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Installer Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Ajouter du swap (important pour 2GB ou moins)

Le swap évite les crashs par manque de mémoire :

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6. Installer OpenClaw

### Option A : Installation standard (recommandée)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Option B : Installation hackable (pour bidouiller)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

L’installation hackable vous donne un accès direct aux logs et au code — utile pour déboguer des problèmes spécifiques à ARM.

## 7. Lancer la prise en main

```bash
openclaw onboard --install-daemon
```

Suivez l'assistant :

1. **Mode Gateway (passerelle) :** Local
2. **Auth :** Clés API recommandées (OAuth peut être capricieux sur un Pi headless)
3. **Canaux :** Telegram est le plus simple pour commencer
4. **Daemon :** Oui (systemd)

## 8) Vérifier l’installation

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Accéder au tableau de bord

Comme le Pi est headless, utilisez un tunnel SSH :

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Ou utilisez Tailscale pour un accès toujours actif :

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Optimisations de performance

### Utiliser un SSD USB (amélioration majeure)

Les cartes SD sont lentes et s’usent. Un SSD USB améliore considérablement les performances :

```bash
# Check if booting from USB
lsblk
```

Voir le [guide de démarrage USB pour Pi](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) pour la configuration.

### Réduire l’utilisation mémoire

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Surveiller les ressources

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## Notes spécifiques à ARM

### Compatibilité binaire

La plupart des fonctionnalités d’OpenClaw fonctionnent sur ARM64, mais certains binaires externes peuvent nécessiter des versions ARM :

| Outil                                    | Statut ARM64 | Notes                               |
| ---------------------------------------- | ------------ | ----------------------------------- |
| Node.js                  | ✅            | Fonctionne très bien                |
| WhatsApp (Baileys)    | ✅            | JS pur, aucun problème              |
| Telegram                                 | ✅            | JS pur, aucun problème              |
| gog (Gmail CLI)       | ⚠️           | Vérifier la disponibilité ARM       |
| Chromium (navigateur) | ✅            | `sudo apt install chromium-browser` |

Si un Skill échoue, vérifiez si son binaire dispose d’une version ARM. De nombreux outils Go/Rust en ont ; certains non.

### 32 bits vs 64 bits

**Utilisez toujours un OS 64 bits.** Node.js et de nombreux outils modernes l’exigent. Vérifiez avec :

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Configuration de modèle recommandée

Comme le Pi n’est que la Gateway (passerelle) (les modèles s’exécutent dans le cloud), utilisez des modèles basés sur API :

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**N’essayez pas d’exécuter des LLM locaux sur un Pi** — même les petits modèles sont trop lents. Laissez Claude/GPT faire le gros du travail.

---

## Démarrage automatique au boot

L’assistant de prise en main configure cela, mais pour vérifier :

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Problemes courants

### Manque de mémoire (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Performance lente

- Utilisez un SSD USB au lieu d’une carte SD
- Désactivez les services inutilisés : `sudo systemctl disable cups bluetooth avahi-daemon`
- Vérifiez le throttling CPU : `vcgencmd get_throttled` (doit retourner `0x0`)

### Le service ne démarre pas

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### Problèmes de binaires ARM

Si un Skill échoue avec « exec format error » :

1. Vérifiez si le binaire dispose d’une version ARM64
2. Essayez de compiler depuis la source
3. Ou utilisez un conteneur Docker avec support ARM

### Déconnexions WiFi

Pour les Pi headless en WiFi :

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Comparaison des coûts

| Configuration                     | Coût unique          | Coût mensuel             | Notes                                                     |
| --------------------------------- | -------------------- | ------------------------ | --------------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                       | + électricité (~$5/an) |
| **Pi 4 (4GB)** | ~$55 | $0                       | Recommandé                                                |
| **Pi 5 (4GB)** | ~$60 | $0                       | Meilleures performances                                   |
| **Pi 5 (8GB)** | ~$80 | $0                       | Vaincre mais à l'épreuve de l'avenir                      |
| DigitalOcean                      | $0                   | $6/mo                    | $72/an                                                    |
| Hetzner                           | $0                   | €3.79/mo | ~$50/an                                   |

**Seuil de rentabilité :** un Pi est amorti en ~6–12 mois par rapport à un VPS cloud.

---

## Voir aussi

- [Guide Linux](/platforms/linux) — configuration Linux générale
- [Guide DigitalOcean](/platforms/digitalocean) — alternative cloud
- [Guide Hetzner](/install/hetzner) — configuration Docker
- [Tailscale](/gateway/tailscale) — accès distant
- [Nodes](/nodes) — associez votre ordinateur/téléphone à la Gateway du Pi
