---
summary: "Configuration de tunnel SSH pour OpenClaw.app se connectant à une passerelle distante"
read_when: "Connexion de l'app macOS à une passerelle distante via SSH"
title: "Configuration de passerelle distante"
---

# Exécuter OpenClaw.app avec une Passerelle distante

OpenClaw.app utilise le tunneling SSH pour se connecter à une passerelle distante. Ce guide vous montre comment le configurer.

## Aperçu

```mermaid
flowchart TB
    subgraph Client["Machine cliente"]
        direction TB
        A["OpenClaw.app"]
        B["ws://127.0.0.1:18789\n(port local)"]
        T["Tunnel SSH"]

        A --> B
        B --> T
    end
    subgraph Remote["Machine distante"]
        direction TB
        C["WebSocket Passerelle"]
        D["ws://127.0.0.1:18789"]

        C --> D
    end
    T --> C
```

## Configuration rapide

### Étape 1 : Ajouter la config SSH

Éditez `~/.ssh/config` et ajoutez :

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # ex. 172.27.187.184
    User <REMOTE_USER>            # ex. jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

Remplacez `<REMOTE_IP>` et `<REMOTE_USER>` avec vos valeurs.

### Étape 2 : Copier la clé SSH

Copiez votre clé publique vers la machine distante (entrez le mot de passe une fois) :

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### Étape 3 : Définir le token Passerelle

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### Étape 4 : Démarrer le tunnel SSH

```bash
ssh -N remote-gateway &
```

### Étape 5 : Redémarrer OpenClaw.app

```bash
# Quitter OpenClaw.app (⌘Q), puis rouvrir :
open /path/to/OpenClaw.app
```

L'app va maintenant se connecter à la passerelle distante via le tunnel SSH.

---

## Démarrage automatique du tunnel à la connexion

Pour que le tunnel SSH démarre automatiquement lorsque vous vous connectez, créez un Launch Agent.

### Créer le fichier PLIST

Sauvegardez ceci comme `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist` :

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

### Charger le Launch Agent

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

Le tunnel va maintenant :

- Démarrer automatiquement lorsque vous vous connectez
- Redémarrer s'il crash
- Continuer de fonctionner en arrière-plan

Note héritée : supprimez tout LaunchAgent `com.openclaw.ssh-tunnel` restant s'il est présent.

---

## Dépannage

**Vérifier si le tunnel fonctionne :**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**Redémarrer le tunnel :**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**Arrêter le tunnel :**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## Comment ça fonctionne

| Composant                            | Ce qu'il fait                                              |
| ------------------------------------ | ---------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | Transfère le port local 18789 vers le port distant 18789   |
| `ssh -N`                             | SSH sans exécuter de commandes distantes (juste transfert) |
| `KeepAlive`                          | Redémarre automatiquement le tunnel s'il crash             |
| `RunAtLoad`                          | Démarre le tunnel quand l'agent se charge                  |

OpenClaw.app se connecte à `ws://127.0.0.1:18789` sur votre machine cliente. Le tunnel SSH transfère cette connexion vers le port 18789 sur la machine distante où la Passerelle s'exécute.
