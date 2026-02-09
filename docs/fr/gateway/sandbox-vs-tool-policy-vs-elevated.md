---
title: Sandbox vs politique d’outil vs Élevé
summary: "Pourquoi un outil est bloqué : runtime de sandbox, politique d’autorisation/refus des outils, et verrous d’exécution élevée"
read_when: "Vous tombez sur la “prison de sandbox” ou voyez un refus d’outil/élevé et voulez la clé de configuration exacte à modifier."
status: active
---

# Sandbox vs politique d’outil vs Élevé

OpenClaw dispose de trois contrôles liés (mais différents) :

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) décide **où les outils s’exécutent** (Docker vs hôte).
2. **Politique d’outil** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) décide **quels outils sont disponibles/autorisés**.
3. **Élevé** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) est une **échappatoire d’exécution uniquement** pour s’exécuter sur l’hôte lorsque vous êtes en sandbox.

## Débogage rapide

Utilisez l’inspecteur pour voir ce qu’OpenClaw fait _réellement_ :

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Il affiche :

- le mode/portée de sandbox effectifs et l’accès à l’espace de travail
- si la session est actuellement en sandbox (principale vs non principale)
- l’autorisation/refus effectifs des outils en sandbox (et s’ils proviennent de l’agent/global/par défaut)
- les verrous « élevé » et les chemins de clés de correction

## Sandbox : où les outils s’exécutent

Le sandboxing est contrôlé par `agents.defaults.sandbox.mode` :

- `"off"` : tout s’exécute sur l’hôte.
- `"non-main"` : seules les sessions non principales sont en sandbox (surprise courante pour les groupes/canaux).
- `"all"` : tout est en sandbox.

Voir [Sandboxing](/gateway/sandboxing) pour la matrice complète (portée, montages d’espace de travail, images).

### Bind mounts (vérification de sécurité rapide)

- `docker.binds` _perce_ le système de fichiers de la sandbox : tout ce que vous montez est visible dans le conteneur avec le mode que vous définissez (`:ro` ou `:rw`).
- Le mode par défaut est lecture-écriture si vous omettez le mode ; préférez `:ro` pour le code source/les secrets.
- `scope: "shared"` ignore les montages par agent (seuls les montages globaux s’appliquent).
- Lier `/var/run/docker.sock` revient à donner le contrôle de l’hôte à la sandbox ; ne le faites que délibérément.
- L’accès à l’espace de travail (`workspaceAccess: "ro"`/`"rw"`) est indépendant des modes de montage.

## Politique d’outil : quels outils existent/sont appelables

Deux couches comptent :

- **Profil d’outils** : `tools.profile` et `agents.list[].tools.profile` (liste d’autorisation de base)
- **Profil d’outils du fournisseur** : `tools.byProvider[provider].profile` et `agents.list[].tools.byProvider[provider].profile`
- **Politique d’outils globale/par agent** : `tools.allow`/`tools.deny` et `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Politique d’outils du fournisseur** : `tools.byProvider[provider].allow/deny` et `agents.list[].tools.byProvider[provider].allow/deny`
- **Politique d’outils de la sandbox** (s’applique uniquement en sandbox) : `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` et `agents.list[].tools.sandbox.tools.*`

Règles empiriques :

- `deny` l’emporte toujours.
- Si `allow` n’est pas vide, tout le reste est traité comme bloqué.
- La politique d’outil est l’arrêt dur : `/exec` ne peut pas outrepasser un outil `exec` refusé.
- `/exec` ne modifie que les valeurs par défaut de session pour les expéditeurs autorisés ; il n’accorde pas l’accès aux outils.
  Les clés d’outils du fournisseur acceptent soit `provider` (par ex. `google-antigravity`), soit `provider/model` (par ex. `openai/gpt-5.2`).

### Groupes d’outils (raccourcis)

Les politiques d’outils (globale, agent, sandbox) prennent en charge des entrées `group:*` qui s’étendent à plusieurs outils :

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

Groupes disponibles :

- `group:runtime` : `exec`, `bash`, `process`
- `group:fs` : `read`, `write`, `edit`, `apply_patch`
- `group:sessions` : `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory` : `memory_search`, `memory_get`
- `group:ui` : `browser`, `canvas`
- `group:automation` : `cron`, `gateway`
- `group:messaging` : `message`
- `group:nodes` : `nodes`
- `group:openclaw` : tous les outils OpenClaw intégrés (exclut les plugins de fournisseurs)

## Élevé : exécution uniquement « sur l’hôte »

Élevé n’accorde **pas** d’outils supplémentaires ; il n’affecte que `exec`.

- Si vous êtes en sandbox, `/elevated on` (ou `exec` avec `elevated: true`) s’exécute sur l’hôte (des approbations peuvent toujours s’appliquer).
- Utilisez `/elevated full` pour ignorer les approbations d’exécution pour la session.
- Si vous vous exécutez déjà directement, Élevé est effectivement sans effet (toujours verrouillé).
- Élevé n’est **pas** limité aux Skills et **ne** remplace **pas** l’autorisation/refus des outils.
- `/exec` est distinct d’Élevé. Il n’ajuste que les valeurs par défaut d’exécution par session pour les expéditeurs autorisés.

Portes :

- Activation : `tools.elevated.enabled` (et éventuellement `agents.list[].tools.elevated.enabled`)
- Listes d’autorisation d’expéditeurs : `tools.elevated.allowFrom.<provider>` (et éventuellement `agents.list[].tools.elevated.allowFrom.<provider>`)

Voir [Mode Élevé](/tools/elevated).

## Correctifs courants de « prison de sandbox »

### « Outil X bloqué par la politique d’outils de la sandbox »

Clés de correction (choisissez-en une) :

- Désactiver la sandbox : `agents.defaults.sandbox.mode=off` (ou par agent `agents.list[].sandbox.mode=off`)
- Autoriser l’outil dans la sandbox :
  - le retirer de `tools.sandbox.tools.deny` (ou par agent `agents.list[].tools.sandbox.tools.deny`)
  - ou l’ajouter à `tools.sandbox.tools.allow` (ou autorisation par agent)

### « Je pensais que c’était la session principale, pourquoi est-elle en sandbox ? »

En mode `"non-main"`, les clés de groupe/canal ne sont _pas_ principales. Utilisez la clé de session principale (affichée par `sandbox explain`) ou passez au mode `"off"`.
