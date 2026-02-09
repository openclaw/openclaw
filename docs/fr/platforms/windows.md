---
summary: "Prise en charge de Windows (WSL2) + statut de l’application compagnon"
read_when:
  - Installation d’OpenClaw sur Windows
  - Recherche du statut de l’application compagnon Windows
title: "Windows (WSL2)"
---

# Windows (WSL2)

OpenClaw sur Windows est recommandé **via WSL2** (Ubuntu recommandé). Le
CLI + le Gateway (passerelle) s’exécutent dans Linux, ce qui maintient un runtime cohérent et rend
les outils bien plus compatibles (Node/Bun/pnpm, binaires Linux, Skills). Le
Windows natif peut être plus délicat. WSL2 vous offre l’expérience Linux complète — une commande
pour installer : `wsl --install`.

Des applications compagnon Windows natives sont prévues.

## Installation (WSL2)

- [Premiers pas](/start/getting-started) (à utiliser dans WSL)
- [Installation et mises à jour](/install/updating)
- Guide officiel WSL2 (Microsoft) : https://learn.microsoft.com/windows/wsl/install

## Gateway (passerelle)

- [Runbook du Gateway](/gateway)
- [Configuration](/gateway/configuration)

## Installation du service Gateway (CLI)

À l’intérieur de WSL2 :

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

Sélectionnez **Gateway service** lorsque vous y êtes invité.

Réparer/migrer :

```
openclaw doctor
```

## Avancé : exposer des services WSL sur le LAN (portproxy)

WSL dispose de son propre réseau virtuel. Si une autre machine doit accéder à un service
s’exécutant **à l’intérieur de WSL** (SSH, un serveur TTS local, ou le Gateway (passerelle)), vous devez
rediriger un port Windows vers l’IP WSL actuelle. L’IP WSL change après les redémarrages,
vous devrez donc peut-être actualiser la règle de redirection.

Exemple (PowerShell **en tant qu’administrateur**) :

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Autoriser le port à travers le pare-feu Windows (une seule fois) :

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Actualiser le portproxy après les redémarrages de WSL :

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Remarques :

- Le SSH depuis une autre machine cible **l’IP de l’hôte Windows** (exemple : `ssh user@windows-host -p 2222`).
- Les nœuds distants doivent pointer vers une URL de Gateway **accessible** (pas `127.0.0.1`) ; utilisez
  `openclaw status --all` pour confirmer.
- Utilisez `listenaddress=0.0.0.0` pour l’accès LAN ; `127.0.0.1` le maintient uniquement en local.
- Si vous souhaitez automatiser cela, enregistrez une tâche planifiée pour exécuter l’étape
  d’actualisation à la connexion.

## Installation WSL2 pas à pas

### 1. Installer WSL2 + Ubuntu

Ouvrez PowerShell (Admin) :

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Redémarrez si Windows le demande.

### 2. Activer systemd (requis pour l’installation du Gateway)

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

Rouvrez Ubuntu, puis vérifiez :

```bash
systemctl --user status
```

### 3. Installer OpenClaw (dans WSL)

Suivez le parcours Linux « Premiers pas » à l’intérieur de WSL :

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Guide complet : [Premiers pas](/start/getting-started)

## Application compagnon Windows

Nous n’avons pas encore d’application compagnon Windows. Les contributions sont bienvenues si vous
souhaitez contribuer à la concrétiser.
