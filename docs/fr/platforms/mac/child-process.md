---
summary: "Cycle de vie de la Gateway sur macOS (launchd)"
read_when:
  - Integration de l'application mac avec le cycle de vie de la Gateway
title: "Cycle de vie de la Gateway"
---

# Cycle de vie de la Gateway sur macOS

L’application macOS **gere la Gateway via launchd** par defaut et ne lance pas
la Gateway en tant que processus enfant. Elle tente d’abord de se connecter a une
Gateway deja en cours d’execution sur le port configure ; si aucune n’est joignable,
elle active le service launchd via le CLI externe `openclaw` (aucun runtime
embarque). Cela vous offre un demarrage automatique fiable a la connexion et un
redemarrage en cas de crash.

Le mode processus enfant (Gateway lancee directement par l’application) **n’est
pas utilise** aujourd’hui.
Si vous avez besoin d’un couplage plus etroit avec l’UI,
lancez la Gateway manuellement dans un terminal.

## Comportement par defaut (launchd)

- L’application installe un LaunchAgent par utilisateur libelle `bot.molt.gateway`
  (ou `bot.molt.<profile>` lors de l’utilisation de `--profile`/`OPENCLAW_PROFILE` ;
  l’ancien `com.openclaw.*` est pris en charge).
- Lorsque le mode Local est active, l’application s’assure que le LaunchAgent est
  charge et demarre la Gateway si necessaire.
- Les journaux sont ecrits vers le chemin de log launchd de la Gateway (visible dans
  les Parametres de debogage).

Commandes courantes :

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Remplacez le libelle par `bot.molt.<profile>` lors de l’execution d’un profil nomme.

## Builds de developpement non signes

`scripts/restart-mac.sh --no-sign` est destine aux builds locaux rapides lorsque vous ne disposez pas
de cles de signature. Pour eviter que launchd ne pointe vers un binaire de relais
non signe, il :

- Ecrit `~/.openclaw/disable-launchagent`.

Les executions signees de `scripts/restart-mac.sh` effacent cette surcharge si le marqueur
est present. Pour reinitialiser manuellement :

```bash
rm ~/.openclaw/disable-launchagent
```

## Mode attachement uniquement

Pour forcer l’application macOS a **ne jamais installer ni gerer launchd**, lancez-la
avec `--attach-only` (ou `--no-launchd`). Cela definit `~/.openclaw/disable-launchagent`, de sorte
que l’application ne fait que se connecter a une Gateway deja en cours d’execution. Vous pouvez activer le meme comportement dans les Parametres de debogage.

## Mode distant

Le mode distant ne demarre jamais de Gateway locale. L’application utilise un tunnel
SSH vers l’hote distant et se connecte via ce tunnel.

## Pourquoi nous privilegions launchd

- Demarrage automatique a la connexion.
- Semantique de redemarrage/KeepAlive integree.
- Journaux et supervision predictibles.

Si un veritable mode processus enfant devait a nouveau etre necessaire, il devrait
etre documente comme un mode distinct, explicite et reserve au developpement.
