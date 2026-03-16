---
title: Sandbox vs Politique d'outil vs Elevated
summary: "Pourquoi un outil est bloqué : runtime sandbox, politique allow/deny d'outil et portes exec élevées"
read_when: "Vous rencontrez 'sandbox jail' ou voyez un refus d'outil/elevated et voulez la clé de config exacte à changer."
status: active
---

# Sandbox vs Politique d'outil vs Elevated

OpenClaw a trois contrôles liés (mais différents) :

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) décide **où les outils s'exécutent** (Docker vs hôte).
2. **Politique d'outil** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) décide **quels outils sont disponibles/autorisés**.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) est une **échappatoire exec-uniquement** pour s'exécuter sur l'hôte lorsque vous êtes sandboxé.

## Débogage rapide

Utilisez l'inspecteur pour voir ce qu'OpenClaw fait _réellement_ :

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Il imprime :

- mode/scope/accès workspace sandbox effectif
- si la session est actuellement sandboxée (main vs non-main)
- allow/deny d'outil sandbox effectif (et s'il vient d'agent/global/défaut)
- portes elevated et chemins de clé de correction

## Sandbox : où les outils s'exécutent

Le sandboxing est contrôlé par `agents.defaults.sandbox.mode` :

- `"off"` : tout s'exécute sur l'hôte.
- `"non-main"` : seules les sessions non-main sont sandboxées (commune "surprise" pour groupes/canaux).
- `"all"` : tout est sandboxé.

Voir [Sandboxing](/fr-FR/gateway/sandboxing) pour la matrice complète (scope, montages workspace, images).

### Montages Bind (vérification rapide de sécurité)

- `docker.binds` _perce_ le système de fichiers sandbox : tout ce que vous montez est visible à l'intérieur du conteneur avec le mode que vous définissez (`:ro` ou `:rw`).
- Le défaut est lecture-écriture si vous omettez le mode ; préférez `:ro` pour source/secrets.
- `scope: "shared"` ignore les binds par agent (seuls les binds globaux s'appliquent).
- Lier `/var/run/docker.sock` donne effectivement le contrôle hôte au sandbox ; faites-le seulement intentionnellement.
- L'accès workspace (`workspaceAccess: "ro"`/`"rw"`) est indépendant des modes bind.

## Politique d'outil : quels outils existent/sont appelables

Deux couches comptent :

- **Profil d'outil** : `tools.profile` et `agents.list[].tools.profile` (liste autorisée de base)
- **Profil d'outil fournisseur** : `tools.byProvider[provider].profile` et `agents.list[].tools.byProvider[provider].profile`
- **Politique d'outil globale/par-agent** : `tools.allow`/`tools.deny` et `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Politique d'outil fournisseur** : `tools.byProvider[provider].allow/deny` et `agents.list[].tools.byProvider[provider].allow/deny`
- **Politique d'outil sandbox** (s'applique uniquement lorsque sandboxé) : `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` et `agents.list[].tools.sandbox.tools.*`

Règles d'usage :

- `deny` gagne toujours.
- Si `allow` est non vide, tout le reste est traité comme bloqué.
- La politique d'outil est l'arrêt dur : `/exec` ne peut pas remplacer un outil `exec` refusé.
- `/exec` ne change que les défauts de session pour les expéditeurs autorisés ; il n'accorde pas l'accès outil.
  Les clés d'outil fournisseur acceptent soit `provider` (ex. `google-antigravity`) soit `provider/model` (ex. `openai/gpt-5.2`).

### Groupes d'outils (raccourcis)

Les politiques d'outil (global, agent, sandbox) supportent les entrées `group:*` qui s'étendent à plusieurs outils :

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

Groupes disponibles :

- `group:runtime` : `exec`, `bash`, `process`
- `group:fs` : `read`, `write`, `edit`, `apply_patch`
- `group:sessions` : `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory` : `memory_search`, `memory_get`
- `group:ui` : `browser`, `canvas`
- `group:automation` : `cron`, `gateway`
- `group:messaging` : `message`
- `group:nodes` : `nodes`
- `group:openclaw` : tous les outils intégrés OpenClaw (exclut les plugins fournisseur)

## Elevated : exec-uniquement "exécuter sur hôte"

Elevated n'**accorde pas** d'outils supplémentaires ; il n'affecte que `exec`.

- Si vous êtes sandboxé, `/elevated on` (ou `exec` avec `elevated: true`) s'exécute sur l'hôte (les approbations peuvent toujours s'appliquer).
- Utilisez `/elevated full` pour sauter les approbations exec pour la session.
- Si vous êtes déjà en direct, elevated est effectivement un no-op (toujours contrôlé).
- Elevated n'est **pas** scopé par compétence et ne **remplace pas** allow/deny d'outil.
- `/exec` est séparé d'elevated. Il n'ajuste que les défauts exec par session pour les expéditeurs autorisés.

Portes :

- Activation : `tools.elevated.enabled` (et optionnellement `agents.list[].tools.elevated.enabled`)
- Listes autorisées d'expéditeur : `tools.elevated.allowFrom.<provider>` (et optionnellement `agents.list[].tools.elevated.allowFrom.<provider>`)

Voir [Mode Elevated](/fr-FR/tools/elevated).

## Corrections "sandbox jail" courantes

### "Outil X bloqué par politique d'outil sandbox"

Clés de correction (choisissez-en une) :

- Désactiver le sandbox : `agents.defaults.sandbox.mode=off` (ou par-agent `agents.list[].sandbox.mode=off`)
- Autoriser l'outil à l'intérieur du sandbox :
  - supprimez-le de `tools.sandbox.tools.deny` (ou par-agent `agents.list[].tools.sandbox.tools.deny`)
  - ou ajoutez-le à `tools.sandbox.tools.allow` (ou allow par-agent)

### "Je pensais que c'était main, pourquoi est-ce sandboxé ?"

En mode `"non-main"`, les clés groupe/canal ne sont _pas_ main. Utilisez la clé de session main (affichée par `sandbox explain`) ou changez le mode vers `"off"`.
