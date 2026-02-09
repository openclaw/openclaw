---
summary: "Fonctionnement du sandboxing d’OpenClaw : modes, portées, accès à l’espace de travail et images"
title: Sandboxing
read_when: "Vous voulez une explication dédiée du sandboxing ou devez ajuster agents.defaults.sandbox."
status: active
---

# Sandboxing

OpenClaw peut exécuter **des outils à l’intérieur de conteneurs Docker** afin de réduire le rayon d’impact.
Ceci est **optionnel** et contrôlé par la configuration (`agents.defaults.sandbox` ou
`agents.list[].sandbox`). Si le sandboxing est désactivé, les outils s’exécutent sur l’hôte.
La Gateway reste sur l’hôte ; l’exécution des outils se fait dans un sandbox isolé
lorsqu’il est activé.

Il ne s’agit pas d’une frontière de sécurité parfaite, mais cela limite de manière significative
l’accès au système de fichiers et aux processus lorsque le modèle fait quelque chose d’inapproprié.

## Ce qui est sandboxé

- Exécution des outils (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, etc.).
- Navigateur sandboxé optionnel (`agents.defaults.sandbox.browser`).
  - Par défaut, le navigateur sandbox démarre automatiquement (garantit que le CDP est accessible) lorsque l’outil de navigateur en a besoin.
    Configuration via `agents.defaults.sandbox.browser.autoStart` et `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` permet aux sessions sandboxées de cibler explicitement le navigateur de l’hôte.
  - Des listes d’autorisation optionnelles contrôlent `target: "custom"` : `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Non sandboxé :

- Le processus de la Gateway lui-même.
- Tout outil explicitement autorisé à s’exécuter sur l’hôte (p. ex. `tools.elevated`).
  - **L’exécution avec privilèges élevés s’exécute sur l’hôte et contourne le sandboxing.**
  - Si le sandboxing est désactivé, `tools.elevated` ne change pas l’exécution (déjà sur l’hôte). Voir [Elevated Mode](/tools/elevated).

## Modes

`agents.defaults.sandbox.mode` contrôle **quand** le sandboxing est utilisé :

- `"off"` : pas de sandboxing.
- `"non-main"` : sandbox uniquement pour les sessions **non principales** (par défaut si vous voulez des discussions normales sur l’hôte).
- `"all"` : chaque session s’exécute dans un sandbox.
  Remarque : `"non-main"` est basé sur `session.mainKey` (par défaut `"main"`), et non sur l’identifiant d’agent.
  Les sessions de groupe/canal utilisent leurs propres clés ; elles sont donc considérées comme non principales et seront sandboxées.

## Périmètre d'application

`agents.defaults.sandbox.scope` contrôle **le nombre de conteneurs** créés :

- `"session"` (par défaut) : un conteneur par session.
- `"agent"` : un conteneur par agent.
- `"shared"` : un conteneur partagé par toutes les sessions sandboxées.

## Accès à l’espace de travail

`agents.defaults.sandbox.workspaceAccess` contrôle **ce que le sandbox peut voir** :

- `"none"` (par défaut) : les outils voient un espace de travail sandbox sous `~/.openclaw/sandboxes`.
- `"ro"` : monte l’espace de travail de l’agent en lecture seule à `/agent` (désactive `write`/`edit`/`apply_patch`).
- `"rw"` : monte l’espace de travail de l’agent en lecture/écriture à `/workspace`.

Les médias entrants sont copiés dans l’espace de travail sandbox actif (`media/inbound/*`).
Note sur les Skills : l’outil `read` est ancré à la racine du sandbox. Avec `workspaceAccess: "none"`,
OpenClaw met en miroir les skills éligibles dans l’espace de travail sandbox (`.../skills`) afin
qu’ils puissent être lus. Avec `"rw"`, les skills de l’espace de travail sont lisibles depuis
`/workspace/skills`.

## Montages bind personnalisés

`agents.defaults.sandbox.docker.binds` monte des répertoires hôte supplémentaires dans le conteneur.
Format : `host:container:mode` (p. ex., `"/home/user/source:/source:rw"`).

Les montages globaux et par agent sont **fusionnés** (non remplacés). Sous `scope: "shared"`, les montages par agent sont ignorés.

Exemple (source en lecture seule + socket Docker) :

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

- Les montages contournent le système de fichiers du sandbox : ils exposent des chemins de l’hôte avec le mode que vous définissez (`:ro` ou `:rw`).
- Les montages sensibles (p. ex., `docker.sock`, secrets, clés SSH) doivent être `:ro` sauf nécessité absolue.
- Combinez avec `workspaceAccess: "ro"` si vous n’avez besoin que d’un accès en lecture à l’espace de travail ; les modes de montage restent indépendants.
- Voir [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) pour comprendre comment les montages interagissent avec la politique d’outils et l’exécution avec privilèges élevés.

## Images + configuration

Image par défaut : `openclaw-sandbox:bookworm-slim`

Construisez-la une fois :

```bash
scripts/sandbox-setup.sh
```

Remarque : l’image par défaut **n’inclut pas** Node. Si un skill a besoin de Node (ou
d’autres runtimes), intégrez une image personnalisée ou installez via
`sandbox.docker.setupCommand` (nécessite une sortie réseau + une racine accessible en écriture +
l’utilisateur root).

Image du navigateur sandboxé :

```bash
scripts/sandbox-browser-setup.sh
```

Par défaut, les conteneurs sandbox s’exécutent **sans réseau**.
Remplacez ce comportement avec `agents.defaults.sandbox.docker.network`.

Les installations Docker et la Gateway conteneurisée se trouvent ici :
[Docker](/install/docker)

## setupCommand (configuration unique du conteneur)

`setupCommand` s’exécute **une seule fois** après la création du conteneur sandbox (pas à chaque exécution).
Il s’exécute à l’intérieur du conteneur via `sh -lc`.

Chemins :

- Global : `agents.defaults.sandbox.docker.setupCommand`
- Par agent : `agents.list[].sandbox.docker.setupCommand`

Pièges communs:

- La valeur par défaut de `docker.network` est `"none"` (pas de sortie), donc les installations de paquets échoueront.
- `readOnlyRoot: true` empêche les écritures ; définissez `readOnlyRoot: false` ou intégrez une image personnalisée.
- `user` doit être root pour les installations de paquets (omettre `user` ou définir `user: "0:0"`).
- L’exécution dans le sandbox **n’hérite pas** des `process.env` de l’hôte. Utilisez
  `agents.defaults.sandbox.docker.env` (ou une image personnalisée) pour les clés d’API des skills.

## Politique d’outils + échappatoires

Les politiques d’autorisation/refus des outils s’appliquent toujours avant les règles de sandbox. Si un outil est refusé
globalement ou par agent, le sandboxing ne le réactive pas.

`tools.elevated` est une échappatoire explicite qui exécute `exec` sur l’hôte.
Les directives `/exec` ne s’appliquent que pour les expéditeurs autorisés et persistent par session ; pour désactiver strictement
`exec`, utilisez le refus via la politique d’outils (voir [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Débogage :

- Utilisez `openclaw sandbox explain` pour inspecter le mode de sandbox effectif, la politique d’outils et les clés de configuration de correction.
- Voir [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) pour le modèle mental « pourquoi est-ce bloqué ? ».
  Gardez-le verrouillé.

## Remplacements multi-agents

Chaque agent peut remplacer sandbox + outils :
`agents.list[].sandbox` et `agents.list[].tools` (ainsi que `agents.list[].tools.sandbox.tools` pour la politique d’outils du sandbox).
Voir [Multi-Agent Sandbox & Tools](/multi-agent-sandbox-tools) pour la priorité.

## Exemple minimal d’activation

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

## Documentation associée

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/multi-agent-sandbox-tools)
- [Security](/gateway/security)
