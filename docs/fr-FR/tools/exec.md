---
summary: "Utilisation outil Exec, modes stdin et support TTY"
read_when:
  - Utilisation ou modification outil exec
  - Débogage comportement stdin ou TTY
title: "Outil Exec"
---

# Outil Exec

Exécuter des commandes shell dans l'espace de travail. Supporte l'exécution premier plan + arrière-plan via `process`. Si `process` est refusé, `exec` s'exécute de manière synchrone et ignore `yieldMs`/`background`. Les sessions arrière-plan sont limitées par agent ; `process` voit uniquement les sessions du même agent.

## Paramètres

- `command` (requis)
- `workdir` (par défaut cwd)
- `env` (remplacements clé/valeur)
- `yieldMs` (par défaut 10000) : arrière-plan automatique après délai
- `background` (bool) : arrière-plan immédiatement
- `timeout` (secondes, par défaut 1800) : tuer à expiration
- `pty` (bool) : exécuter dans pseudo-terminal quand disponible (CLIs TTY uniquement, agents codage, UIs terminal)
- `host` (`sandbox | gateway | node`) : où exécuter
- `security` (`deny | allowlist | full`) : mode application pour `gateway`/`node`
- `ask` (`off | on-miss | always`) : invites approbation pour `gateway`/`node`
- `node` (string) : id/nom nœud pour `host=node`
- `elevated` (bool) : demander mode élevé (hôte passerelle) ; `security=full` est uniquement forcé quand elevated résout à `full`

Notes :

- `host` par défaut `sandbox`.
- `elevated` est ignoré quand sandboxing est désactivé (exec s'exécute déjà sur l'hôte).
- Les approbations `gateway`/`node` sont contrôlées par `~/.openclaw/exec-approvals.json`.
- `node` nécessite un nœud apparié (app compagnon ou hôte nœud headless).
- Si plusieurs nœuds sont disponibles, définissez `exec.node` ou `tools.exec.node` pour en sélectionner un.
- Sur hôtes non-Windows, exec utilise `SHELL` quand défini ; si `SHELL` est `fish`, il préfère `bash` (ou `sh`) depuis `PATH` pour éviter scripts incompatibles fish, puis retombe sur `SHELL` si aucun n'existe.
- L'exécution hôte (`gateway`/`node`) rejette `env.PATH` et remplacements loader (`LD_*`/`DYLD_*`) pour empêcher détournement binaire ou code injecté.
- Important : sandboxing est **désactivé par défaut**. Si sandboxing est désactivé, `host=sandbox` s'exécute directement sur l'hôte passerelle (pas de conteneur) et **ne nécessite pas d'approbations**. Pour nécessiter des approbations, exécutez avec `host=gateway` et configurez approbations exec (ou activez sandboxing).

## Config

- `tools.exec.notifyOnExit` (par défaut : true) : quand true, les sessions exec en arrière-plan enfilent un événement système et demandent un heartbeat à la sortie.
- `tools.exec.approvalRunningNoticeMs` (par défaut : 10000) : émet un seul avis "running" quand un exec gated approbation s'exécute plus longtemps que ceci (0 désactive).
- `tools.exec.host` (par défaut : `sandbox`)
- `tools.exec.security` (par défaut : `deny` pour sandbox, `allowlist` pour gateway + node quand non défini)
- `tools.exec.ask` (par défaut : `on-miss`)
- `tools.exec.node` (par défaut : non défini)
- `tools.exec.pathPrepend` : liste de répertoires à préfixer à `PATH` pour exécutions exec (gateway + sandbox uniquement).
- `tools.exec.safeBins` : binaires sûrs stdin uniquement qui peuvent s'exécuter sans entrées allowlist explicites.

Exemple :

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### Gestion PATH

- `host=gateway` : fusionne votre `PATH` shell connexion dans l'environnement exec. Les remplacements `env.PATH` sont rejetés pour exécution hôte. Le démon lui-même fonctionne toujours avec un `PATH` minimal :
  - macOS : `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux : `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox` : exécute `sh -lc` (shell connexion) dans le conteneur, donc `/etc/profile` peut réinitialiser `PATH`. OpenClaw préfixe `env.PATH` après sourcing profil via une var env interne (pas d'interpolation shell) ; `tools.exec.pathPrepend` s'applique ici aussi.
- `host=node` : seuls les remplacements env non-bloqués que vous passez sont envoyés au nœud. Les remplacements `env.PATH` sont rejetés pour exécution hôte et ignorés par hôtes nœud. Si vous avez besoin d'entrées PATH additionnelles sur un nœud, configurez l'environnement service hôte nœud (systemd/launchd) ou installez outils dans emplacements standard.

Liaison nœud par agent (utilisez l'index liste agents dans config) :

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

UI de Contrôle : l'onglet Nœuds inclut un petit panneau "Liaison nœud Exec" pour les mêmes paramètres.

## Remplacements session (`/exec`)

Utilisez `/exec` pour définir des valeurs par défaut **par session** pour `host`, `security`, `ask` et `node`. Envoyez `/exec` sans arguments pour afficher les valeurs actuelles.

Exemple :

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Modèle d'autorisation

`/exec` est uniquement honoré pour les **expéditeurs autorisés** (allowlists canal/appairage plus `commands.useAccessGroups`). Il met à jour **uniquement l'état session** et n'écrit pas la config. Pour désactiver strictement exec, refusez-le via politique outil (`tools.deny: ["exec"]` ou par agent). Les approbations hôte s'appliquent toujours sauf si vous définissez explicitement `security=full` et `ask=off`.

## Approbations exec (app compagnon / hôte nœud)

Les agents sandboxés peuvent nécessiter approbation par requête avant que `exec` s'exécute sur la passerelle ou hôte nœud. Voir [Approbations Exec](/fr-FR/tools/exec-approvals) pour la politique, allowlist et flux UI.

Quand les approbations sont requises, l'outil exec retourne immédiatement avec `status: "approval-pending"` et un id approbation. Une fois approuvé (ou refusé / expiré), la Passerelle émet des événements système (`Exec finished` / `Exec denied`). Si la commande fonctionne toujours après `tools.exec.approvalRunningNoticeMs`, un seul avis `Exec running` est émis.

## Allowlist + safe bins

L'application allowlist correspond uniquement aux **chemins binaires résolus** (pas de correspondances basename). Quand `security=allowlist`, les commandes shell sont auto-autorisées uniquement si chaque segment pipeline est allowlisté ou un safe bin. Le chaînage (`;`, `&&`, `||`) et redirections sont rejetés en mode allowlist sauf si chaque segment niveau supérieur satisfait l'allowlist (incluant safe bins). Les redirections restent non supportées.

## Exemples

Premier plan :

```json
{ "tool": "exec", "command": "ls -la" }
```

Arrière-plan + poll :

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Envoyer touches (style tmux) :

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

## Voir aussi

- [Approbations Exec](/fr-FR/tools/exec-approvals)
- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
