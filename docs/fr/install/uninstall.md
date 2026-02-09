---
summary: "Désinstaller OpenClaw complètement (CLI, service, état, espace de travail)"
read_when:
  - Vous souhaitez supprimer OpenClaw d’une machine
  - Le service Gateway (passerelle) fonctionne encore après la désinstallation
title: "Désinstaller"
---

# Désinstaller

Deux chemins :

- **Méthode simple** si `openclaw` est encore installé.
- **Suppression manuelle du service** si la CLI a disparu mais que le service fonctionne toujours.

## Méthode simple (CLI encore installée)

Recommandé : utilisez le désinstalleur intégré :

```bash
openclaw uninstall
```

Non interactif (automatisation / npx) :

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Étapes manuelles (même résultat) :

1. Arrêter le service Gateway (passerelle) :

```bash
openclaw gateway stop
```

2. Désinstaller le service Gateway (passerelle) (launchd/systemd/schtasks) :

```bash
openclaw gateway uninstall
```

3. Supprimer l’état + la configuration :

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Si vous avez défini `OPENCLAW_CONFIG_PATH` vers un emplacement personnalisé en dehors du répertoire d’état, supprimez également ce fichier.

4. Supprimer votre espace de travail (facultatif, supprime les fichiers d’agent) :

```bash
rm -rf ~/.openclaw/workspace
```

5. Supprimer l’installation de la CLI (choisissez celle que vous avez utilisée) :

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Si vous avez installé l’application macOS :

```bash
rm -rf /Applications/OpenClaw.app
```

Notes :

- Si vous avez utilisé des profils (`--profile` / `OPENCLAW_PROFILE`), répétez l’étape 3 pour chaque répertoire d’état (les valeurs par défaut sont `~/.openclaw-<profile>`).
- En mode distant, le répertoire d’état se trouve sur **l’hôte de la Gateway (passerelle)** ; exécutez donc les étapes 1 à 4 également sur cet hôte.

## Suppression manuelle du service (CLI non installée)

Utilisez cette méthode si le service Gateway (passerelle) continue de fonctionner mais que `openclaw` est manquant.

### macOS (launchd)

L’étiquette par défaut est `bot.molt.gateway` (ou `bot.molt.<profile>` ; l’ancienne `com.openclaw.*` peut encore exister) :

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Si vous avez utilisé un profil, remplacez l’étiquette et le nom du plist par `bot.molt.<profile>`. Supprimez tout plist hérité `com.openclaw.*` s’il est présent.

### Linux (unité utilisateur systemd)

Le nom d’unité par défaut est `openclaw-gateway.service` (ou `openclaw-gateway-<profile>.service`) :

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (tâche planifiée)

Le nom de tâche par défaut est `OpenClaw Gateway` (ou `OpenClaw Gateway (<profile>)`).
Le script de la tâche se trouve sous votre répertoire d’état.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Si vous avez utilisé un profil, supprimez le nom de tâche correspondant et `~\.openclaw-<profile>\gateway.cmd`.

## Installation normale vs dépôt source

### Installation normale (install.sh / npm / pnpm / bun)

Si vous avez utilisé `https://openclaw.ai/install.sh` ou `install.ps1`, la CLI a été installée avec `npm install -g openclaw@latest`.
Supprimez-la avec `npm rm -g openclaw` (ou `pnpm remove -g` / `bun remove -g` si vous avez installé de cette façon).

### Dépôt source (git clone)

Si vous exécutez depuis un dépôt cloné (`git clone` + `openclaw ...` / `bun run openclaw ...`) :

1. Désinstallez le service Gateway (passerelle) **avant** de supprimer le dépôt (utilisez la méthode simple ci-dessus ou la suppression manuelle du service).
2. Supprimez le répertoire du dépôt.
3. Supprimez l’état + l’espace de travail comme indiqué ci-dessus.
