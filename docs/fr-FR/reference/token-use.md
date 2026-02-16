---
summary: "Comment OpenClaw construit contexte prompt et rapporte utilisation token + coûts"
read_when:
  - Explication utilisation token, coûts ou fenêtres contexte
  - Débogage croissance contexte ou comportement compaction
title: "Utilisation Token et Coûts"
---

# Utilisation Token & Coûts

OpenClaw track **tokens**, pas caractères. Tokens sont model-spécifiques, mais la plupart modèles style OpenAI moyennent ~4 caractères par token pour texte anglais.

## Comment prompt système est construit

OpenClaw assemble son propre prompt système sur chaque run. Inclut :

- Liste outil + descriptions courtes
- Liste compétences (métadonnées uniquement ; instructions chargées on demand avec `read`)
- Instructions self-update
- Fichiers workspace + bootstrap (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` quand nouveau, plus `MEMORY.md` et/ou `memory.md` quand présents). Gros fichiers tronqués par `agents.defaults.bootstrapMaxChars` (défaut : 20000), et injection bootstrap totale cappée par `agents.defaults.bootstrapTotalMaxChars` (défaut : 24000).
- Temps (UTC + timezone utilisateur)
- Tags réponse + comportement heartbeat
- Métadonnées runtime (host/OS/model/thinking)

Voir breakdown complet dans [Prompt Système](/fr-FR/concepts/system-prompt).

## Ce qui compte dans fenêtre contexte

Tout ce que modèle reçoit compte vers limite contexte :

- Prompt système (toutes sections listées ci-dessus)
- Historique conversation (messages utilisateur + assistant)
- Appels outil et résultats outil
- Pièces jointes/transcripts (images, audio, fichiers)
- Résumés compaction et artifacts pruning
- Wrappers provider ou headers sécurité (pas visibles, mais toujours comptés)

Pour breakdown pratique (par fichier injecté, outils, compétences et taille prompt système), utilisez `/context list` ou `/context detail`. Voir [Contexte](/fr-FR/concepts/context).

## Comment voir utilisation token actuelle

Utilisez dans chat :

- `/status` → **carte statut emoji-rich** avec modèle session, usage contexte, derniers tokens réponse input/output et **coût estimé** (API key uniquement).
- `/usage off|tokens|full` → append **footer usage per-response** à chaque réponse.
  - Persiste per session (stocké comme `responseUsage`).
  - Auth OAuth **cache coût** (tokens uniquement).
- `/usage cost` → montre résumé coût local depuis logs session OpenClaw.

Autres surfaces :

- **TUI/Web TUI :** `/status` + `/usage` supportés.
- **CLI :** `openclaw status --usage` et `openclaw channels list` montrent fenêtres quota provider (pas coûts per-response).

## Estimation coût (quand montrée)

Coûts estimés depuis config prix modèle :

```json5
{
  models: {
    providers: {
      anthropic: {
        pricing: {
          "claude-sonnet-4": {
            input: 0.000003,
            output: 0.000015,
          },
        },
      },
    },
  },
}
```

Voir aussi :

- [Coûts Usage API](/fr-FR/reference/api-usage-costs)
- [Contexte](/fr-FR/concepts/context)
- [Configuration](/fr-FR/cli/config)
