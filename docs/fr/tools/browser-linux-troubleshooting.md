---
summary: "Corriger les problèmes de démarrage CDP de Chrome/Brave/Edge/Chromium pour le contrôle du navigateur OpenClaw sous Linux"
read_when: "Le contrôle du navigateur échoue sous Linux, en particulier avec Chromium snap"
title: "Dépannage du navigateur"
---

# Dépannage du navigateur (Linux)

## Problème : « Failed to start Chrome CDP on port 18800 »

Le serveur de contrôle du navigateur d’OpenClaw ne parvient pas à lancer Chrome/Brave/Edge/Chromium avec l’erreur :

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Cause racine

Sur Ubuntu (et de nombreuses distributions Linux), l’installation par défaut de Chromium est un **paquet snap**. Le confinement AppArmor de Snap interfère avec la manière dont OpenClaw lance et surveille le processus du navigateur.

La commande `apt install chromium` installe un paquet factice qui redirige vers snap :

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Ce n’est PAS un vrai navigateur — c’est seulement un wrapper.

### Solution 1 : Installer Google Chrome (recommandé)

Installez le paquet officiel Google Chrome `.deb`, qui n’est pas sandboxé par snap :

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Puis mettez à jour votre configuration OpenClaw (`~/.openclaw/openclaw.json`) :

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### Solution 2 : Utiliser Chromium snap avec le mode « Attach-Only »

Si vous devez utiliser Chromium snap, configurez OpenClaw pour s’attacher à un navigateur démarré manuellement :

1. Mettre à jour la configuration :

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Démarrer Chromium manuellement :

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Créer éventuellement un service utilisateur systemd pour démarrer automatiquement Chrome :

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Activer avec : `systemctl --user enable --now openclaw-browser.service`

### Vérifier que le navigateur fonctionne

Vérifier l’état :

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Tester la navigation :

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Référence de configuration

| Option                   | Description                                                                                            | Valeur par défaut                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `browser.enabled`        | Activer le contrôle du navigateur                                                                      | `true`                                                                                           |
| `browser.executablePath` | Chemin vers un binaire de navigateur basé sur Chromium (Chrome/Brave/Edge/Chromium) | auto-détecté (privilégie le navigateur par défaut s’il est basé sur Chromium) |
| `browser.headless`       | Exécuter sans interface graphique                                                                      | `false`                                                                                          |
| `browser.noSandbox`      | Ajouter le flag `--no-sandbox` (nécessaire pour certaines configurations Linux)     | `false`                                                                                          |
| `browser.attachOnly`     | Ne pas lancer le navigateur, seulement s’attacher à un existant                                        | `false`                                                                                          |
| `browser.cdpPort`        | Port du Chrome DevTools Protocol                                                                       | `18800`                                                                                          |

### Problème : « Chrome extension relay is running, but no tab is connected »

Vous utilisez le profil `chrome` (extension relay). Il s’attend à ce que l’extension de navigateur OpenClaw soit attachée à un onglet actif.

Options de correction :

1. **Utiliser le navigateur géré :** `openclaw browser start --browser-profile openclaw`
   (ou définir `browser.defaultProfile: "openclaw"`).
2. **Utiliser l’extension relay :** installez l’extension, ouvrez un onglet, puis cliquez sur l’icône de l’extension OpenClaw pour l’attacher.

Notes :

- Le profil `chrome` utilise votre **navigateur Chromium par défaut du système** lorsque c’est possible.
- Les profils locaux `openclaw` attribuent automatiquement `cdpPort`/`cdpUrl` ; ne définissez ces paramètres que pour le CDP distant.
