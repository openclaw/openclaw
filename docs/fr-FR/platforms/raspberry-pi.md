---
summary: "OpenClaw sur Raspberry Pi (configuration auto-hébergée économique)"
read_when:
  - Configuration d'OpenClaw sur un Raspberry Pi
  - Exécution d'OpenClaw sur appareils ARM
  - Construction d'une IA personnelle toujours active économique
title: "Raspberry Pi"
---

# OpenClaw sur Raspberry Pi

## Objectif

Exécuter une Passerelle OpenClaw persistante, toujours active sur un Raspberry Pi pour **~35-80 $** de coût unique (pas de frais mensuels).

Parfait pour :

- Assistant IA personnel 24/7
- Hub d'automatisation domestique
- Bot Telegram/WhatsApp basse consommation, toujours disponible

## Exigences matérielles

| Modèle Pi       | RAM     | Fonctionne ? | Notes                          |
| --------------- | ------- | ------------ | ------------------------------ |
| **Pi 5**        | 4GB/8GB | ✅ Meilleur  | Le plus rapide, recommandé     |
| **Pi 4**        | 4GB     | ✅ Bon       | Bon compromis pour la plupart  |
| **Pi 4**        | 2GB     | ✅ OK        | Fonctionne, ajoutez du swap    |
| **Pi 4**        | 1GB     | ⚠️ Serré     | Possible avec swap, config min |
| **Pi 3B+**      | 1GB     | ⚠️ Lent      | Fonctionne mais lent           |
| **Pi Zero 2 W** | 512MB   | ❌           | Non recommandé                 |

**Specs minimum :** 1GB RAM, 1 cœur, 500MB disque  
**Recommandé :** 2GB+ RAM, OS 64-bit, carte SD 16GB+ (ou SSD USB)

## Ce dont vous aurez besoin

- Raspberry Pi 4 ou 5 (2GB+ recommandé)
- Carte MicroSD (16GB+) ou SSD USB (meilleure performance)
- Alimentation (PSU officiel Pi recommandé)
- Connexion réseau (Ethernet ou WiFi)
- ~30 minutes

## 1) Flasher l'OS

Utilisez **Raspberry Pi OS Lite (64-bit)** — pas de bureau nécessaire pour un serveur headless.

1. Téléchargez [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Choisissez OS : **Raspberry Pi OS Lite (64-bit)**
3. Cliquez sur l'icône engrenage (⚙️) pour pré-configurer :
   - Définir le hostname : `gateway-host`
   - Activer SSH
   - Définir nom d'utilisateur/mot de passe
   - Configurer WiFi (si pas Ethernet)
4. Flashez sur votre carte SD / clé USB
5. Insérez et démarrez le Pi

## 2) Connecter via SSH

```bash
ssh user@gateway-host
# ou utilisez l'adresse IP
ssh user@192.168.x.x
```

## 3) Configuration système

```bash
# Mettre à jour le système
sudo apt update && sudo apt upgrade -y

# Installer les paquets essentiels
sudo apt install -y git curl build-essential

# Définir le fuseau horaire (important pour cron/rappels)
sudo timedatectl set-timezone America/Chicago  # Changez pour votre fuseau horaire
```

## 4) Installer Node.js 22 (ARM64)

```bash
# Installer Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Vérifier
node --version  # Devrait afficher v22.x.x
npm --version
```

## 5) Ajouter du Swap (Important pour 2GB ou moins)

Le swap empêche les crashs out-of-memory :

```bash
# Créer fichier swap de 2GB
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Rendre permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimiser pour RAM faible (réduire swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6) Installer OpenClaw

### Option A : Installation Standard (Recommandée)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Option B : Installation Hackable (Pour bidouiller)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

L'installation hackable vous donne un accès direct aux journaux et au code — utile pour déboguer les problèmes spécifiques ARM.

## 7) Exécuter l'Onboarding

```bash
openclaw onboard --install-daemon
```

Suivez l'assistant :

1. **Mode passerelle :** Local
2. **Auth :** Clés API recommandées (OAuth peut être capricieux sur Pi headless)
3. **Canaux :** Telegram est le plus facile pour commencer
4. **Daemon :** Oui (systemd)

## 8) Vérifier l'Installation

```bash
# Vérifier le statut
openclaw status

# Vérifier le service
sudo systemctl status openclaw

# Voir les journaux
journalctl -u openclaw -f
```

## 9) Accéder au Tableau de bord

Comme le Pi est headless, utilisez un tunnel SSH :

```bash
# Depuis votre ordinateur portable/bureau
ssh -L 18789:localhost:18789 user@gateway-host

# Puis ouvrez dans le navigateur
open http://localhost:18789
```

Ou utilisez Tailscale pour un accès toujours actif :

```bash
# Sur le Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Mettre à jour la config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Optimisations de Performance

### Utiliser un SSD USB (Énorme amélioration)

Les cartes SD sont lentes et s'usent. Un SSD USB améliore considérablement les performances :

```bash
# Vérifier si démarrage depuis USB
lsblk
```

Voir [guide de démarrage USB Pi](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) pour la configuration.

### Réduire l'Utilisation Mémoire

```bash
# Désactiver l'allocation mémoire GPU (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Désactiver Bluetooth si non nécessaire
sudo systemctl disable bluetooth
```

### Surveiller les Ressources

```bash
# Vérifier la mémoire
free -h

# Vérifier la température CPU
vcgencmd measure_temp

# Surveillance en direct
htop
```

---

## Notes Spécifiques ARM

### Compatibilité Binaire

La plupart des fonctionnalités OpenClaw fonctionnent sur ARM64, mais certains binaires externes peuvent nécessiter des builds ARM :

| Outil              | Statut ARM64 | Notes                               |
| ------------------ | ------------ | ----------------------------------- |
| Node.js            | ✅           | Fonctionne très bien                |
| WhatsApp (Baileys) | ✅           | JS pur, pas de problèmes            |
| Telegram           | ✅           | JS pur, pas de problèmes            |
| gog (Gmail CLI)    | ⚠️           | Vérifier pour version ARM           |
| Chromium (browser) | ✅           | `sudo apt install chromium-browser` |

Si une compétence échoue, vérifiez si son binaire a un build ARM. Beaucoup d'outils Go/Rust le font ; certains non.

### 32-bit vs 64-bit

**Utilisez toujours un OS 64-bit.** Node.js et beaucoup d'outils modernes le nécessitent. Vérifiez avec :

```bash
uname -m
# Devrait afficher : aarch64 (64-bit) pas armv7l (32-bit)
```

---

## Configuration Modèle Recommandée

Comme le Pi est juste la Passerelle (les modèles s'exécutent dans le cloud), utilisez des modèles basés API :

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

**N'essayez pas d'exécuter des LLM locaux sur un Pi** — même les petits modèles sont trop lents. Laissez Claude/GPT faire le gros du travail.

---

## Démarrage Automatique au Boot

L'assistant d'onboarding configure cela, mais pour vérifier :

```bash
# Vérifier que le service est activé
sudo systemctl is-enabled openclaw

# Activer si non
sudo systemctl enable openclaw

# Démarrer au boot
sudo systemctl start openclaw
```

---

## Dépannage

### Out of Memory (OOM)

```bash
# Vérifier la mémoire
free -h

# Ajouter plus de swap (voir Étape 5)
# Ou réduire les services s'exécutant sur le Pi
```

### Performance Lente

- Utilisez SSD USB au lieu de carte SD
- Désactivez les services inutilisés : `sudo systemctl disable cups bluetooth avahi-daemon`
- Vérifiez le throttling CPU : `vcgencmd get_throttled` (devrait retourner `0x0`)

### Le Service ne Démarre Pas

```bash
# Vérifier les journaux
journalctl -u openclaw --no-pager -n 100

# Correction courante : reconstruire
cd ~/openclaw  # si utilisation installation hackable
npm run build
sudo systemctl restart openclaw
```

### Problèmes Binaires ARM

Si une compétence échoue avec "exec format error" :

1. Vérifiez si le binaire a un build ARM64
2. Essayez de construire depuis les sources
3. Ou utilisez un conteneur Docker avec support ARM

### WiFi qui Coupe

Pour Pi headless sur WiFi :

```bash
# Désactiver la gestion d'alimentation WiFi
sudo iwconfig wlan0 power off

# Rendre permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Comparaison de Coûts

| Configuration  | Coût Unique | Coût Mensuel | Notes                       |
| -------------- | ----------- | ------------ | --------------------------- |
| **Pi 4 (2GB)** | ~45 $       | 0 $          | + électricité (~5 $/an)     |
| **Pi 4 (4GB)** | ~55 $       | 0 $          | Recommandé                  |
| **Pi 5 (4GB)** | ~60 $       | 0 $          | Meilleure performance       |
| **Pi 5 (8GB)** | ~80 $       | 0 $          | Surdimensionné mais pérenne |
| DigitalOcean   | 0 $         | 6 $/mois     | 72 $/an                     |
| Hetzner        | 0 $         | 3,79 €/mois  | ~50 $/an                    |

**Point d'équilibre :** Un Pi s'amortit en ~6-12 mois vs VPS cloud.

---

## Voir Aussi

- [Guide Linux](/fr-FR/platforms/linux) — configuration Linux générale
- [Guide DigitalOcean](/fr-FR/platforms/digitalocean) — alternative cloud
- [Guide Hetzner](/fr-FR/install/hetzner) — configuration Docker
- [Tailscale](/fr-FR/gateway/tailscale) — accès distant
- [Nœuds](/fr-FR/nodes) — appairer votre ordinateur/téléphone avec la passerelle Pi
