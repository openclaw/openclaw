---
summary: "Plan : ajouter le point de terminaison OpenResponses /v1/responses et déprécier proprement les complétions de chat"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "Plan de la Gateway OpenResponses"
---

# Plan d’intégration de la Gateway OpenResponses

## Contexte

La Gateway OpenClaw expose actuellement un point de terminaison minimal de Chat Completions compatible OpenAI à
`/v1/chat/completions` (voir [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses est une norme ouverte d’inférence basée sur l’API OpenAI Responses. Elle est conçue
pour des workflows agentiques et utilise des entrées basées sur des éléments ainsi que des événements de streaming sémantiques. La spécification OpenResponses
définit `/v1/responses`, et non `/v1/chat/completions`.

## Objectifs

- Ajouter un point de terminaison `/v1/responses` qui respecte la sémantique OpenResponses.
- Conserver Chat Completions comme couche de compatibilité, facile à désactiver et à supprimer à terme.
- Standardiser la validation et l’analyse avec des schémas isolés et réutilisables.

## Non‑objectifs

- Parité complète des fonctionnalités OpenResponses lors du premier passage (images, fichiers, outils hébergés).
- Remplacement de la logique interne d’exécution des agents ou de l’orchestration des outils.
- Modification du comportement existant `/v1/chat/completions` durant la première phase.

## Résumé de la recherche

Sources : OpenAPI OpenResponses, site de la spécification OpenResponses et billet de blog Hugging Face.

Points clés extraits :

- `POST /v1/responses` accepte des champs `CreateResponseBody` tels que `model`, `input` (chaîne ou
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` et
  `max_tool_calls`.
- `ItemParam` est une union discriminée de :
  - éléments `message` avec les rôles `system`, `developer`, `user`, `assistant`
  - `function_call` et `function_call_output`
  - `reasoning`
  - `item_reference`
- Les réponses réussies renvoient un `ResponseResource` avec des éléments `object: "response"`, `status` et
  `output`.
- Le streaming utilise des événements sémantiques tels que :
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- La spécification exige :
  - `Content-Type: text/event-stream`
  - `event:` doit correspondre au champ JSON `type`
  - l’événement terminal doit être le littéral `[DONE]`
- Les éléments de raisonnement peuvent exposer `content`, `encrypted_content` et `summary`.
- Les exemples HF incluent `OpenResponses-Version: latest` dans les requêtes (en-tête optionnel).

## Architecture proposée

- Ajouter `src/gateway/open-responses.schema.ts` contenant uniquement des schémas Zod (sans imports de la gateway).
- Ajouter `src/gateway/openresponses-http.ts` (ou `open-responses-http.ts`) pour `/v1/responses`.
- Conserver `src/gateway/openai-http.ts` intact comme adaptateur de compatibilité hérité.
- Ajouter la configuration `gateway.http.endpoints.responses.enabled` (par défaut `false`).
- Conserver `gateway.http.endpoints.chatCompletions.enabled` indépendant ; permettre l’activation/désactivation séparée des deux points de terminaison.
- Émettre un avertissement au démarrage lorsque Chat Completions est activé afin de signaler son statut hérité.

## Trajectoire de dépréciation pour Chat Completions

- Maintenir des frontières de modules strictes : aucun type de schéma partagé entre responses et chat completions.
- Rendre Chat Completions opt-in via la configuration afin de pouvoir le désactiver sans changements de code.
- Mettre à jour la documentation pour étiqueter Chat Completions comme hérité une fois `/v1/responses` stable.
- Étape future optionnelle : mapper les requêtes Chat Completions vers le gestionnaire Responses pour simplifier la suppression.

## Sous-ensemble pris en charge – Phase 1

- Accepter `input` comme chaîne ou `ItemParam[]` avec des rôles de message et `function_call_output`.
- Extraire les messages system et developer dans `extraSystemPrompt`.
- Utiliser le plus récent `user` ou `function_call_output` comme message courant pour les exécutions d’agent.
- Rejeter les parties de contenu non prises en charge (image/fichier) avec `invalid_request_error`.
- Renvoyer un seul message assistant avec le contenu `output_text`.
- Renvoyer `usage` avec des valeurs à zéro jusqu’à ce que la comptabilisation des tokens soit câblée.

## Stratégie de validation (sans SDK)

- Implémenter des schémas Zod pour le sous-ensemble pris en charge de :
  - `CreateResponseBody`
  - `ItemParam` + unions des parties de contenu de message
  - `ResponseResource`
  - Formes d’événements de streaming utilisées par la gateway
- Conserver les schémas dans un module unique et isolé afin d’éviter les dérives et de permettre une génération de code future.

## Implémentation du streaming (Phase 1)

- Lignes SSE avec à la fois `event:` et `data:`.
- Séquence requise (minimum viable) :
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (répéter si nécessaire)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Tests et plan de vérification

- Ajouter une couverture e2e pour `/v1/responses` :
  - Authentification requise
  - Forme de réponse non streamée
  - Ordonnancement des événements de stream et `[DONE]`
  - Routage de session avec en-têtes et `user`
- Conserver `src/gateway/openai-http.e2e.test.ts` inchangé.
- Manuel : curl vers `/v1/responses` avec `stream: true` et vérifier l’ordre des événements et le terminal
  `[DONE]`.

## Mises à jour de la documentation (suivi)

- Ajouter une nouvelle page de documentation pour l’utilisation et les exemples de `/v1/responses`.
- Mettre à jour `/gateway/openai-http-api` avec une note « hérité » et un pointeur vers `/v1/responses`.
