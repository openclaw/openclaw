---
summary: "Référence : règles de nettoyage et de réparation des transcriptions spécifiques aux fournisseurs"
read_when:
  - Vous déboguez des rejets de requêtes côté fournisseur liés à la forme de la transcription
  - Vous modifiez la logique de nettoyage des transcriptions ou de réparation des appels d’outils
  - Vous enquêtez sur des incohérences d’identifiants d’appels d’outils entre fournisseurs
title: "Hygiène des transcriptions"
---

# Hygiène des transcriptions (Correctifs fournisseurs)

Ce document décrit les **correctifs spécifiques aux fournisseurs** appliqués aux transcriptions avant une exécution
(construction du contexte du modèle). Il s’agit d’ajustements **en mémoire** utilisés pour satisfaire des
exigences strictes des fournisseurs. Ces étapes d’hygiène ne **réécrivent pas** la transcription JSONL stockée
sur disque ; toutefois, une passe distincte de réparation des fichiers de session peut réécrire des fichiers
JSONL malformés en supprimant les lignes invalides avant le chargement de la session. Lorsqu’une réparation
a lieu, le fichier d’origine est sauvegardé à côté du fichier de session.

Le périmètre inclut :

- Nettoyage des identifiants d’appels d’outils
- Validation des entrées d’appels d’outils
- Réparation de l’appariement des résultats d’outils
- Validation / ordre des tours
- Nettoyage des signatures de pensée
- Nettoyage des charges utiles d’images

Si vous avez besoin de détails sur le stockage des transcriptions, voir :

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Où cela s’exécute

Toute l’hygiène des transcriptions est centralisée dans l’exécuteur embarqué :

- Sélection de la politique : `src/agents/transcript-policy.ts`
- Application du nettoyage/de la réparation : `sanitizeSessionHistory` dans `src/agents/pi-embedded-runner/google.ts`

La politique utilise `provider`, `modelApi` et `modelId` pour décider quoi appliquer.

Indépendamment de l’hygiène des transcriptions, les fichiers de session sont réparés (si nécessaire) avant le chargement :

- `repairSessionFileIfNeeded` dans `src/agents/session-file-repair.ts`
- Appelé depuis `run/attempt.ts` et `compact.ts` (exécuteur embarqué)

---

## Règle globale : nettoyage des images

Les charges utiles d’images sont toujours nettoyées afin d’éviter des rejets côté fournisseur dus aux
limites de taille (réduction d’échelle/recompression des images base64 surdimensionnées).

Implémentation :

- `sanitizeSessionMessagesImages` dans `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` dans `src/agents/tool-images.ts`

---

## Règle globale : appels d’outils malformés

Les blocs d’appels d’outils de l’assistant auxquels il manque à la fois `input` et `arguments` sont supprimés
avant la construction du contexte du modèle. Cela évite des rejets côté fournisseur dus à des appels d’outils
partiellement persistés (par exemple, après un échec dû à une limite de débit).

Implémentation :

- `sanitizeToolCallInputs` dans `src/agents/session-transcript-repair.ts`
- Appliqué dans `sanitizeSessionHistory` dans `src/agents/pi-embedded-runner/google.ts`

---

## Matrice des fournisseurs (comportement actuel)

**OpenAI / OpenAI Codex**

- Nettoyage des images uniquement.
- Lors d’un changement de modèle vers OpenAI Responses/Codex, suppression des signatures de raisonnement orphelines (éléments de raisonnement autonomes sans bloc de contenu suivant).
- Aucun nettoyage des identifiants d’appels d’outils.
- Aucune réparation de l’appariement des résultats d’outils.
- Aucune validation ni réordonnancement des tours.
- Aucun résultat d’outil synthétique.
- Aucune suppression des signatures de pensée.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Nettoyage des identifiants d’appels d’outils : alphanumérique strict.
- Réparation de l’appariement des résultats d’outils et résultats d’outils synthétiques.
- Validation des tours (alternance des tours de type Gemini).
- Correctif d’ordre des tours Google (préfixer un minuscule amorçage utilisateur si l’historique commence par l’assistant).
- Antigravity Claude : normalisation des signatures de pensée ; suppression des blocs de pensée non signés.

**Anthropic / Minimax (compatibles Anthropic)**

- Réparation de l’appariement des résultats d’outils et résultats d’outils synthétiques.
- Validation des tours (fusion des tours utilisateur consécutifs pour satisfaire une alternance stricte).

**Mistral (y compris la détection basée sur l’identifiant de modèle)**

- Nettoyage des identifiants d’appels d’outils : strict9 (alphanumérique de longueur 9).

**OpenRouter Gemini**

- Nettoyage des signatures de pensée : suppression des valeurs `thought_signature` non base64 (conserver base64).

**Tout le reste**

- Nettoyage des images uniquement.

---

## Comportement historique (avant 2026.1.22)

Avant la version 2026.1.22, OpenClaw appliquait plusieurs couches d’hygiène des transcriptions :

- Une **extension de nettoyage des transcriptions** s’exécutait à chaque construction de contexte et pouvait :
  - Réparer l’appariement utilisation/résultat des outils.
  - Nettoyer les identifiants d’appels d’outils (y compris un mode non strict qui préservait `_`/`-`).
- L’exécuteur effectuait également un nettoyage spécifique aux fournisseurs, ce qui dupliquait le travail.
- Des mutations supplémentaires se produisaient en dehors de la politique fournisseur, notamment :
  - Suppression des balises `<final>` du texte de l’assistant avant persistance.
  - Suppression des tours d’erreur d’assistant vides.
  - Tronquage du contenu de l’assistant après des appels d’outils.

Cette complexité a provoqué des régressions inter‑fournisseurs (notamment l’appariement `openai-responses`
`call_id|fc_id`). Le nettoyage de 2026.1.22 a supprimé l’extension, centralisé la logique
dans l’exécuteur et rendu OpenAI **sans intervention** au‑delà du nettoyage des images.
