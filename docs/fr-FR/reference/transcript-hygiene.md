---
summary: "Référence : règles sanitization et réparation transcript spécifiques provider"
read_when:
  - Vous déboguez rejets requête provider liés à forme transcript
  - Vous changez logique sanitization transcript ou réparation tool-call
  - Vous investigez mismatches id tool-call à travers providers
title: "Hygiène Transcript"
---

# Hygiène Transcript (Fixups Provider)

Ce document décrit **fixes provider-spécifiques** appliqués aux transcripts avant run (construction contexte modèle). Ce sont ajustements **in-memory** utilisés pour satisfaire exigences provider strictes. Ces étapes hygiène ne **réécrivent pas** transcript JSONL stocké sur disque ; cependant, passe réparation session-file séparée peut réécrire fichiers JSONL malformés en droppant lignes invalides avant chargement session. Quand réparation arrive, fichier original backed up aux côtés fichier session.

Scope inclut :

- Sanitization id tool call
- Validation input tool call
- Réparation pairing résultat tool
- Validation / ordering turn
- Cleanup signature thought
- Sanitization payload image
- Tagging provenance user-input (pour prompts routés inter-session)

Si vous avez besoin détails stockage transcript, voir :

- [/fr-FR/reference/session-management-compaction](/fr-FR/reference/session-management-compaction)

---

## Où ceci s'exécute

Toute hygiène transcript centralisée dans runner embarqué :

- Sélection politique : `src/agents/transcript-policy.ts`
- Application sanitization/réparation : `sanitizeSessionHistory` dans `src/agents/pi-embedded-runner/google.ts`

Politique utilise `provider`, `modelApi` et `modelId` pour décider quoi appliquer.

Séparément hygiène transcript, fichiers session réparés (si nécessaire) avant load :

- `repairSessionFileIfNeeded` dans `src/agents/session-file-repair.ts`
- Appelé depuis `run/attempt.ts` et `compact.ts` (runner embarqué)

## Fixups Provider-Spécifiques

### Google (Gemini)

- **Tool call ID sanitization** : IDs doivent matcher `[a-zA-Z0-9_-]+`
- **Image sanitization** : Supprime metadata, optimise payloads

### Anthropic (Claude)

- **Thought cleanup** : Supprime blocs thinking avant envoi
- **Tool result pairing** : Assure tool results correspondent tool calls

### OpenAI

- **Input validation** : Valide JSON input tool calls
- **Turn ordering** : Corrige ordre turns si nécessaire

Voir aussi :

- [Session Management](/fr-FR/reference/session-management-compaction)
- [Providers](/fr-FR/providers/index)
- [Configuration](/fr-FR/gateway/configuration)
