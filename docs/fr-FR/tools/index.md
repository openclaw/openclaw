---
summary: "Surface outil agent pour OpenClaw (browser, canvas, nœuds, message, cron) remplaçant legacy compétences `openclaw-*`"
read_when:
  - Ajout ou modification outils agent
  - Retrait ou changement compétences `openclaw-*`
title: "Outils"
---

# Outils (OpenClaw)

OpenClaw expose des **outils agent first-class** pour browser, canvas, nœuds et cron.
Ceux-ci remplacent les anciennes compétences `openclaw-*` : les outils sont typés, pas de shelling,
et l'agent devrait s'appuyer directement sur eux.

## Désactiver les outils

Vous pouvez globalement autoriser/refuser des outils via `tools.allow` / `tools.deny` dans `openclaw.json`
(deny gagne). Cela empêche les outils refusés d'être envoyés aux fournisseurs modèles.

```json5
{
  tools: { deny: ["browser"] },
}
```

Notes :

- La correspondance est insensible à la casse.
- Les wildcards `*` sont supportés (`"*"` signifie tous les outils).
- Si `tools.allow` référence uniquement des noms outils plugin inconnus ou non chargés, OpenClaw log un avertissement et ignore l'allowlist donc les outils core restent disponibles.

## Profils outils (allowlist base)

`tools.profile` définit une **allowlist outils base** avant `tools.allow`/`tools.deny`.
Override par agent : `agents.list[].tools.profile`.

Profils :

- `minimal` : `session_status` uniquement
- `coding` : `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging` : `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full` : pas de restriction (identique à non défini)

Exemple (messaging uniquement par défaut, autoriser outils Slack + Discord aussi) :

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Exemple (profil coding, mais refuser exec/process partout) :

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Exemple (profil coding global, agent support messaging uniquement) :

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Outils disponibles

Voir docs spécifiques outils :

- [Browser](/fr-FR/tools/browser)
- [Exec](/fr-FR/tools/exec)
- [Lobster](/fr-FR/tools/lobster)
- [Message](/fr-FR/cli/message)
- [Compétences](/fr-FR/tools/skills)
- [Plugins](/fr-FR/tools/plugin)

Pour config complète : [Configuration](/fr-FR/gateway/configuration)
