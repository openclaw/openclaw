---
summary: "Fix problèmes démarrage Chrome/Brave/Edge/Chromium CDP pour contrôle browser OpenClaw sur Linux"
read_when: "Contrôle browser échoue sur Linux, spécialement avec snap Chromium"
title: "Troubleshooting Browser"
---

# Troubleshooting Browser (Linux)

## Problème : "Failed to start Chrome CDP on port 18800"

Serveur contrôle browser OpenClaw échoue lancer Chrome/Brave/Edge/Chromium avec erreur :

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Cause racine

Sur Ubuntu (et beaucoup distros Linux), installation Chromium défaut est **package snap**. Confinement AppArmor snap interfère avec comment OpenClaw spawne et monitore processus browser.

Commande `apt install chromium` installe package stub qui redirige vers snap :

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Ce n'est **pas** browser réel — juste wrapper.

### Solution 1 : Installer Google Chrome (Recommandé)

Installer package `.deb` Google Chrome officiel, qui n'est pas sandboxed par snap :

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # si erreurs dépendances
```

Puis mettre à jour config OpenClaw (`~/.openclaw/openclaw.json`) :

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

### Solution 2 : Utiliser Snap Chromium avec Mode Attach-Only

Si vous devez utiliser snap Chromium, configurez OpenClaw pour attacher vers browser démarré manuellement :

1. Mettre à jour config :

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

2. Démarrer Chromium manuellement :

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Optionnellement créer service systemd user pour auto-start Chrome :

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser CDP
After=network.target

[Service]
Type=simple
ExecStart=/snap/bin/chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=%h/.openclaw/browser/openclaw/user-data \
  about:blank
Restart=on-failure

[Install]
WantedBy=default.target
```

Activer :

```bash
systemctl --user daemon-reload
systemctl --user enable openclaw-browser
systemctl --user start openclaw-browser
```

### Solution 3 : Installer Brave Browser

Brave est alternative Chromium sans snap :

```bash
sudo curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
  https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] \
  https://brave-browser-apt-release.s3.brave.com/ stable main" | \
  sudo tee /etc/apt/sources.list.d/brave-browser-release.list
sudo apt update
sudo apt install brave-browser
```

Config :

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/brave-browser",
    "headless": true,
    "noSandbox": true
  }
}
```

## Autres problèmes communs

### "Chrome crashed" ou "Browser disconnected"

**Causes possibles :**

- Mémoire insuffisante
- Sandbox pas supporté
- Permissions filesystem

**Solutions :**

```json
{
  "browser": {
    "noSandbox": true,
    "args": ["--disable-dev-shm-usage", "--disable-setuid-sandbox"]
  }
}
```

### Port 18800 déjà utilisé

```bash
# Trouver processus utilisant port
sudo lsof -i :18800

# Tuer processus
kill <PID>

# Ou changer port OpenClaw
openclaw config set browser.port 18801
```

### Headless marche pas

Certains distros ont problèmes avec headless mode :

```json
{
  "browser": {
    "headless": false,
    "display": ":99" // Utiliser Xvfb
  }
}
```

Installer Xvfb :

```bash
sudo apt install xvfb
Xvfb :99 -screen 0 1024x768x24 &
export DISPLAY=:99
```

## Vérification installation

Tester browser manuellement :

```bash
# Google Chrome
google-chrome-stable --version

# Brave
brave-browser --version

# Chromium snap (pas recommandé)
chromium-browser --version
```

Tester CDP :

```bash
# Démarrer avec debugging
google-chrome-stable --headless --no-sandbox \
  --remote-debugging-port=18800 about:blank &

# Vérifier connection
curl http://localhost:18800/json
```

## Configuration complète Linux

Exemple config robuste pour Linux :

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true,
    "port": 18800,
    "args": [
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--no-first-run",
      "--no-default-browser-check"
    ],
    "profiles": {
      "openclaw": {
        "color": "#00AA00"
      }
    }
  }
}
```

## Dépannage avancé

**Logs détaillés :**

```bash
# Voir logs gateway
tail -f ~/.openclaw/logs/gateway.log

# Voir logs browser
tail -f ~/.openclaw/browser/openclaw/chrome-debug.log
```

**Tester connection CDP directe :**

```bash
# Installer wscat
npm i -g wscat

# Connecter vers CDP
wscat -c ws://localhost:18800/devtools/browser
```

**Vérifier permissions :**

```bash
# User data directory
ls -la ~/.openclaw/browser/openclaw/

# Exécutable Chrome
ls -la /usr/bin/google-chrome-stable
```

Voir aussi :

- [Browser](/fr-FR/tools/browser)
- [Extension Chrome](/fr-FR/tools/chrome-extension)
- [Nodes](/fr-FR/nodes/index)
- [Configuration](/fr-FR/gateway/configuration)
