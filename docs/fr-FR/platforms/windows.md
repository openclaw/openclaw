---
summary: "Support Windows (WSL2) + statut de l'application compagnon"
read_when:
  - Installation d'OpenClaw sur Windows
  - Recherche du statut de l'application compagnon Windows
title: "Windows (WSL2)"
---

# Windows (WSL2)

OpenClaw sur Windows est recommandé **via WSL2** (Ubuntu recommandé). Le CLI + Passerelle s'exécutent à l'intérieur de Linux, ce qui maintient le runtime cohérent et rend les outils bien plus compatibles (Node/Bun/pnpm, binaires Linux, compétences). Windows natif pourrait être plus délicat. WSL2 vous donne l'expérience Linux complète — une commande pour installer : `wsl --install`.

Les applications compagnons Windows natives sont prévues.

## Installation (WSL2)

- [Premiers pas](/fr-FR/start/getting-started) (à utiliser dans WSL)
- [Installation & mises à jour](/fr-FR/install/updating)
- Guide officiel WSL2 (Microsoft) : [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Passerelle

- [Runbook Passerelle](/fr-FR/gateway)
- [Configuration](/fr-FR/gateway/configuration)

## Installation du service Passerelle (CLI)

Dans WSL2 :

```
openclaw onboard --install-daemon
```

Ou :

```
openclaw gateway install
```

Ou :

```
openclaw configure
```

Sélectionnez **Service Passerelle** lorsque demandé.

Réparation/migration :

```
openclaw doctor
```

## Avancé : exposer les services WSL sur le LAN (portproxy)

WSL a son propre réseau virtuel. Si une autre machine doit atteindre un service exécuté **dans WSL** (SSH, un serveur TTS local, ou la Passerelle), vous devez transférer un port Windows vers l'IP WSL actuelle. L'IP WSL change après les redémarrages, vous devrez donc peut-être rafraîchir la règle de transfert.

Exemple (PowerShell **en tant qu'Administrateur**) :

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "IP WSL introuvable." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Autoriser le port via le Pare-feu Windows (une fois) :

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Rafraîchir le portproxy après les redémarrages de WSL :

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Remarques :

- SSH depuis une autre machine cible l'**IP de l'hôte Windows** (exemple : `ssh user@windows-host -p 2222`).
- Les nœuds distants doivent pointer vers une URL Passerelle **accessible** (pas `127.0.0.1`) ; utilisez `openclaw status --all` pour confirmer.
- Utilisez `listenaddress=0.0.0.0` pour l'accès LAN ; `127.0.0.1` le garde local uniquement.
- Si vous voulez que ce soit automatique, enregistrez une Tâche Planifiée pour exécuter l'étape de rafraîchissement à la connexion.

## Installation pas à pas de WSL2

### 1) Installer WSL2 + Ubuntu

Ouvrir PowerShell (Admin) :

```powershell
wsl --install
# Ou choisir une distro explicitement :
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Redémarrer si Windows le demande.

### 2) Activer systemd (requis pour l'installation de la passerelle)

Dans votre terminal WSL :

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Puis depuis PowerShell :

```powershell
wsl --shutdown
```

Ré-ouvrir Ubuntu, puis vérifier :

```bash
systemctl --user status
```

### 3) Installer OpenClaw (dans WSL)

Suivre le flux Linux Premiers pas dans WSL :

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # installe automatiquement les dépendances UI au premier lancement
pnpm build
openclaw onboard
```

Guide complet : [Premiers pas](/fr-FR/start/getting-started)

## Application compagnon Windows

Nous n'avons pas encore d'application compagnon Windows. Les contributions sont les bienvenues si vous souhaitez aider à la réaliser.
