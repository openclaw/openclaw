---
summary: "Configuration d’un tunnel SSH pour OpenClaw.app se connectant à une Gateway distante"
read_when: "Connexion de l’application macOS à une Gateway distante via SSH"
title: "Configuration de la Gateway distante"
---

# Exécuter OpenClaw.app avec une Gateway distante

OpenClaw.app utilise un tunnel SSH pour se connecter à une Gateway distante. Ce guide vous montre comment la configurer.

## Présentation

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Machine                          │
│                                                              │
│  OpenClaw.app ──► ws://127.0.0.1:18789 (local port)           │
│                     │                                        │
│                     ▼                                        │
│  SSH Tunnel ────────────────────────────────────────────────│
│                     │                                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                         Remote Machine                        │
│                                                              │
│  Gateway WebSocket ──► ws://127.0.0.1:18789 ──►              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Demarrage rapide

### Étape 1 : Ajouter la configuration SSH

Modifiez `~/.ssh/config` et ajoutez :

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

Remplacez `<REMOTE_IP>` et `<REMOTE_USER>` par vos valeurs.

### Étape 2 : Copier la clé SSH

Copiez votre clé publique sur la machine distante (saisissez le mot de passe une fois) :

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### Étape 3 : Définir le jeton de la Gateway

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### Étape 4 : Démarrer le tunnel SSH

```bash
ssh -N remote-gateway &
```

### Étape 5 : Redémarrer OpenClaw.app

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

L’application se connectera désormais à la Gateway distante via le tunnel SSH.

---

## Démarrage automatique du tunnel à la connexion

Pour que le tunnel SSH démarre automatiquement lorsque vous vous connectez, créez un agent de lancement.

### Créer le fichier PLIST

Enregistrez ceci sous `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist` :

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>bot.molt.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Charger l’agent de lancement

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

Le tunnel va désormais :

- Démarrer automatiquement à la connexion
- Redémarrer en cas de crash
- Continuer à s’exécuter en arrière-plan

Note héritée : supprimez tout LaunchAgent `com.openclaw.ssh-tunnel` restant, le cas échéant.

---

## Problemes courants

**Vérifier si le tunnel est en cours d’exécution :**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**Redémarrer le tunnel :**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**Arrêter le tunnel :**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## Fonctionnement

| Composant                            | Ce que ça fait                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | Transfère le port local 18789 vers le port distant 18789                                       |
| `ssh -N`                             | SSH sans exécuter de commandes distantes (uniquement le transfert de ports) |
| `KeepAlive`                          | Redémarre automatiquement le tunnel en cas de crash                                            |
| `RunAtLoad`                          | Démarre le tunnel lorsque l’agent se charge                                                    |

OpenClaw.app se connecte à `ws://127.0.0.1:18789` sur votre machine cliente. Le tunnel SSH transfère cette connexion vers le port 18789 sur la machine distante où la Gateway (passerelle) est en cours d’exécution.
