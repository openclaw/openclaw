---
summary: "Désinstaller complètement OpenClaw (CLI, services de passerelle, fichiers de données)"
read_when:
  - Je veux désinstaller OpenClaw
  - Je souhaite nettoyer mon système
title: "Désinstallation"
---

# Désinstallation

## Arrêter la passerelle (recommandé)

```bash
openclaw gateway stop
```

Cela arrête votre passerelle en cours d'exécution mais **ne désinstalle pas** les services supervisés.

## Supprimer le service de passerelle supervisé (si installé)

```bash
openclaw gateway uninstall
```

- Sur **macOS**, cela décharge et supprime l'agent de lancement (ex : `bot.molt.gateway.plist`).
- Sur **Linux**, cela désactive et supprime le service systemd (ex : `openclaw-gateway.service`).

Notez que si vous avez plusieurs profils, vous devrez désinstaller chaque label : `openclaw gateway uninstall <profile>`.

Si vous avez ancien labels hérités (`com.openclaw.*` ou `ai.openclaw.*`), `openclaw doctor` devrait recommander la migration. Sinon, supprimez manuellement :

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/<label_ancien>.plist
rm ~/Library/LaunchAgents/<label_ancien>.plist
```

Vérifiez :

```bash
openclaw gateway status
```

Vous devriez voir "Gateway is not running".

## Supprimer l'installation OpenClaw

### Installations globales (npm / pnpm)

```bash
npm uninstall -g openclaw
```

ou

```bash
pnpm rm -g openclaw
```

### Installations depuis la source (git clone)

Supprimez le checkout :

```bash
rm -rf ~/openclaw
```

### Application macOS

Faites glisser **OpenClaw.app** depuis `/Applications` vers la **Corbeille**.

L'application bundle macOS utilise la même installation CLI + passerelle que d'autres méthodes. Si vous désinstallez l'application, le CLI reste fonctionnel. Inversement, supprimer le CLI cassera l'application.

## Supprimer les données, configurations et journaux (optionnel)

Les répertoires système :

```bash
rm -rf ~/.openclaw
```

Cela supprime :

- `openclaw.json` - votre fichier de configuration
- `credentials/` - jetons de connexion du fournisseur
- `workspace/` - code utilisateur + hooks
- `agents/` - agents skill (conversation, plans, sessions)
- `sessions/` - journaux de session (WhatsApp/Telegram/discord...)
- `cache/` - modèles en cache, assets
- `logs/` - journaux de la passerelle (rotation et indexation)
- Données de conversation du contrôleur de passerelle (état de session, gestionnaire de tâches, routes, conversations en cours)

Si vous avez des profils de passerelle nommés, leurs données vivent dans `~/.openclaw-<profile>`.

Vérifiez :

```bash
ls ~/.openclaw*
```

Supprimez tout `~/.openclaw-*` que vous ne voulez pas conserver.

## Désinstaller Docker (si vous utilisez Docker)

Images locales :

```bash
docker rmi $(docker images 'openclaw*' -q)
```

Conteneurs :

```bash
docker rm $(docker ps -a -q --filter ancestor=openclaw/openclaw)
```

Volumes :

```bash
docker volume rm openclaw_config openclaw_workspace
```

Compose :

```bash
docker compose down -v
```

## Désinstaller Nix

Si vous avez utilisé Nix pour installer :

```bash
nix profile remove openclaw
```

## Désinstaller depuis Homebrew (hérité)

Si vous avez utilisé Homebrew avant (obsolète) :

```bash
brew uninstall openclaw
```

Notez que le tap Homebrew d'OpenClaw est obsolète ; utilisez l'installateur du site web ou npm/pnpm à la place.

## Désinstaller sur Windows

Vous avez probablement exécuté :

```powershell
irm https://openclaw.ai/install.ps1 | iex
```

Pour désinstaller :

```powershell
npm uninstall -g openclaw
```

Ensuite, supprimez les fichiers de configuration (PowerShell) :

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.openclaw
```

Si vous avez utilisé WSL2, suivez les étapes de désinstallation Linux à l'intérieur de votre distribution WSL.

## Supprimer les hooks shell (optionnel)

OpenClaw peut installer un hook shell (détection d'erreur, résumé de contexte CLI).

Vérifiez `~/.bashrc` / `~/.zshrc` / `~/.config/fish/config.fish` pour les lignes :

```bash
eval "$(openclaw shell-hook)"
```

Supprimez ou commentez. Redémarrez votre shell.

## Vérifier que tout a disparu

```bash
which openclaw
ls ~/.openclaw
openclaw --version
```

Si `which openclaw` renvoie un chemin, il reste une installation quelque part (souvent répertoire bin Homebrew ou pnpm-home ou npm global).

Si vous voyez toujours `openclaw`, trouvez et supprimez le binaire :

```bash
rm $(which openclaw)
```

## Pourquoi désinstallez-vous ?

Si quelque chose ne fonctionne pas, essayez d'abord `openclaw doctor` + `openclaw update`. Postez sur Discord si bloqué : [https://discord.gg/clawd](https://discord.gg/clawd)

Sinon : **bon vent, ami !** 👋
