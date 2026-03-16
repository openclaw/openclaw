---
summary: "Comment fonctionne le sandboxing OpenClaw : modes, scopes, accès workspace et images"
title: Sandboxing
read_when: "Vous voulez une explication dédiée du sandboxing ou devez ajuster agents.defaults.sandbox."
status: active
---

# Sandboxing

OpenClaw peut exécuter **les outils à l'intérieur de conteneurs Docker** pour réduire le rayon d'explosion. C'est **optionnel** et contrôlé par configuration (`agents.defaults.sandbox` ou `agents.list[].sandbox`). Si le sandboxing est désactivé, les outils s'exécutent sur l'hôte. La Passerelle reste sur l'hôte ; l'exécution d'outil se déroule dans un sandbox isolé lorsqu'activé.

Ce n'est pas une frontière de sécurité parfaite, mais elle limite matériellement l'accès système de fichiers et processus lorsque le modèle fait quelque chose de stupide.

## Ce qui est sandboxé

- Exécution d'outil (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, etc.).
- Navigateur sandboxé optionnel (`agents.defaults.sandbox.browser`).
  - Par défaut, le navigateur sandbox démarre automatiquement (assure que CDP est accessible) lorsque l'outil navigateur en a besoin. Configurez via `agents.defaults.sandbox.browser.autoStart` et `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` permet aux sessions sandboxées de cibler le navigateur hôte explicitement.
  - Les listes autorisées optionnelles contrôlent `target: "custom"` : `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Pas sandboxé :

- Le processus Passerelle lui-même.
- Tout outil explicitement autorisé à s'exécuter sur l'hôte (ex. `tools.elevated`).
  - **Exec elevated s'exécute sur l'hôte et contourne le sandboxing.**
  - Si le sandboxing est désactivé, `tools.elevated` ne change pas l'exécution (déjà sur hôte). Voir [Mode Elevated](/fr-FR/tools/elevated).

## Modes

`agents.defaults.sandbox.mode` contrôle **quand** le sandboxing est utilisé :

- `"off"` : pas de sandboxing.
- `"non-main"` : sandbox uniquement les sessions **non-main** (défaut si vous voulez les chats normaux sur hôte).
- `"all"` : chaque session s'exécute dans un sandbox.
  Note : `"non-main"` est basé sur `session.mainKey` (défaut `"main"`), pas l'id agent.
  Les sessions groupe/canal utilisent leurs propres clés, donc elles comptent comme non-main et seront sandboxées.

## Scope

`agents.defaults.sandbox.scope` contrôle **combien de conteneurs** sont créés :

- `"session"` (défaut) : un conteneur par session.
- `"agent"` : un conteneur par agent.
- `"shared"` : un conteneur partagé par toutes les sessions sandboxées.

## Accès workspace

`agents.defaults.sandbox.workspaceAccess` contrôle **ce que le sandbox peut voir** :

- `"none"` (défaut) : les outils voient un workspace sandbox sous `~/.openclaw/sandboxes`.
- `"ro"` : monte le workspace agent en lecture seule à `/agent` (désactive `write`/`edit`/`apply_patch`).
- `"rw"` : monte le workspace agent en lecture/écriture à `/workspace`.

Les médias entrants sont copiés dans le workspace sandbox actif (`media/inbound/*`). Note compétences : l'outil `read` est rooté-sandbox. Avec `workspaceAccess: "none"`, OpenClaw reflète les compétences éligibles dans le workspace sandbox (`.../skills`) pour qu'elles puissent être lues. Avec `"rw"`, les compétences workspace sont lisibles depuis `/workspace/skills`.

## Montages bind personnalisés

`agents.defaults.sandbox.docker.binds` monte des répertoires hôte supplémentaires dans le conteneur. Format : `host:container:mode` (ex. `"/home/user/source:/source:rw"`).

Les binds globaux et par-agent sont **fusionnés** (pas remplacés). Sous `scope: "shared"`, les binds par-agent sont ignorés.

`agents.defaults.sandbox.browser.binds` monte des répertoires hôte supplémentaires dans le conteneur **navigateur sandbox** uniquement.

- Lorsque défini (incluant `[]`), il remplace `agents.defaults.sandbox.docker.binds` pour le conteneur navigateur.
- Lorsqu'omis, le conteneur navigateur revient à `agents.defaults.sandbox.docker.binds` (rétrocompatible).

Exemple (source lecture seule + socket docker) :

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Notes de sécurité :

- Les binds contournent le système de fichiers sandbox : ils exposent les chemins hôte avec le mode que vous définissez (`:ro` ou `:rw`).
- Les montages sensibles (ex. `docker.sock`, secrets, clés SSH) devraient être `:ro` sauf si absolument requis.
- Combinez avec `workspaceAccess: "ro"` si vous n'avez besoin que d'un accès en lecture au workspace ; les modes bind restent indépendants.
- Voir [Sandbox vs Politique d'outil vs Elevated](/fr-FR/gateway/sandbox-vs-tool-policy-vs-elevated) pour comment les binds interagissent avec la politique d'outil et exec elevated.

## Images + configuration

Image par défaut : `openclaw-sandbox:bookworm-slim`

Construisez-la une fois :

```bash
scripts/sandbox-setup.sh
```

Note : l'image par défaut n'**inclut pas** Node. Si une compétence a besoin de Node (ou d'autres runtimes), soit cuisez une image personnalisée soit installez via `sandbox.docker.setupCommand` (nécessite sortie réseau + root inscriptible + utilisateur root).

Image navigateur sandboxé :

```bash
scripts/sandbox-browser-setup.sh
```

Par défaut, les conteneurs sandbox s'exécutent **sans réseau**. Remplacez avec `agents.defaults.sandbox.docker.network`.

Les installations Docker et la passerelle containerisée vivent ici : [Docker](/fr-FR/install/docker)

## setupCommand (configuration conteneur unique)

`setupCommand` s'exécute **une fois** après la création du conteneur sandbox (pas à chaque exécution). Il s'exécute à l'intérieur du conteneur via `sh -lc`.

Chemins :

- Global : `agents.defaults.sandbox.docker.setupCommand`
- Par-agent : `agents.list[].sandbox.docker.setupCommand`

Pièges courants :

- Le `docker.network` par défaut est `"none"` (pas de sortie), donc les installations de paquets échoueront.
- `readOnlyRoot: true` empêche les écritures ; définissez `readOnlyRoot: false` ou cuisez une image personnalisée.
- `user` doit être root pour les installations de paquets (omettez `user` ou définissez `user: "0:0"`).
- Exec sandbox n'**hérite pas** de `process.env` hôte. Utilisez `agents.defaults.sandbox.docker.env` (ou une image personnalisée) pour les clés API de compétence.

## Politique d'outil + échappatoires

Les politiques allow/deny d'outil s'appliquent toujours avant les règles sandbox. Si un outil est refusé globalement ou par-agent, le sandboxing ne le ramène pas.

`tools.elevated` est une échappatoire explicite qui exécute `exec` sur l'hôte. Les directives `/exec` s'appliquent uniquement pour les expéditeurs autorisés et persistent par session ; pour hard-désactiver `exec`, utilisez la politique d'outil deny (voir [Sandbox vs Politique d'outil vs Elevated](/fr-FR/gateway/sandbox-vs-tool-policy-vs-elevated)).

Débogage :

- Utilisez `openclaw sandbox explain` pour inspecter le mode sandbox effectif, la politique d'outil et les clés de config de correction.
- Voir [Sandbox vs Politique d'outil vs Elevated](/fr-FR/gateway/sandbox-vs-tool-policy-vs-elevated) pour le modèle mental "pourquoi est-ce bloqué ?". Gardez-le verrouillé.

## Overrides multi-agent

Chaque agent peut remplacer sandbox + outils : `agents.list[].sandbox` et `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` pour la politique d'outil sandbox). Voir [Sandbox & Outils multi-agent](/fr-FR/tools/multi-agent-sandbox-tools) pour la précédence.

## Exemple d'activation minimal

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Docs liées

- [Configuration sandbox](/fr-FR/gateway/configuration#agentsdefaults-sandbox)
- [Sandbox & Outils multi-agent](/fr-FR/tools/multi-agent-sandbox-tools)
- [Sécurité](/fr-FR/gateway/security)
