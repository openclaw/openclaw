---
summary: "Environnement d'exécution de l'agent (pi-mono embarqué), contrat d'espace de travail et amorçage de session"
read_when:
  - Vous modifiez l'environnement d'exécution de l'agent, l'amorçage de l'espace de travail ou le comportement de session
title: "Environnement d'exécution de l'agent"
---

# Environnement d'exécution de l'agent 🤖

OpenClaw exécute un environnement d'exécution d'agent embarqué unique dérivé de **pi-mono**.

## Espace de travail (requis)

OpenClaw utilise un répertoire d'espace de travail d'agent unique (`agents.defaults.workspace`) comme **seul** répertoire de travail (`cwd`) de l'agent pour les outils et le contexte.

Recommandé : utilisez `openclaw setup` pour créer `~/.openclaw/openclaw.json` s'il est manquant et initialiser les fichiers d'espace de travail.

Disposition complète de l'espace de travail + guide de sauvegarde : [Espace de travail de l'agent](/fr-FR/concepts/agent-workspace)

Si `agents.defaults.sandbox` est activé, les sessions non-main peuvent remplacer cela avec
des espaces de travail par session sous `agents.defaults.sandbox.workspaceRoot` (voir
[Configuration de la passerelle](/fr-FR/gateway/configuration)).

## Fichiers d'amorçage (injectés)

Dans `agents.defaults.workspace`, OpenClaw s'attend à ces fichiers éditables par l'utilisateur :

- `AGENTS.md` — instructions d'exploitation + "mémoire"
- `SOUL.md` — personnalité, limites, ton
- `TOOLS.md` — notes d'outils maintenues par l'utilisateur (par ex. `imsg`, `sag`, conventions)
- `BOOTSTRAP.md` — rituel unique de première exécution (supprimé après achèvement)
- `IDENTITY.md` — nom/ambiance/emoji de l'agent
- `USER.md` — profil utilisateur + adresse préférée

Au premier tour d'une nouvelle session, OpenClaw injecte le contenu de ces fichiers directement dans le contexte de l'agent.

Les fichiers vides sont ignorés. Les gros fichiers sont réduits et tronqués avec un marqueur pour que les invites restent légères (lisez le fichier pour le contenu complet).

Si un fichier manque, OpenClaw injecte une seule ligne de marqueur "fichier manquant" (et `openclaw setup` créera un modèle par défaut sécurisé).

`BOOTSTRAP.md` n'est créé que pour un **tout nouvel espace de travail** (aucun autre fichier d'amorçage présent). Si vous le supprimez après avoir terminé le rituel, il ne devrait pas être recréé lors des redémarrages ultérieurs.

Pour désactiver complètement la création de fichiers d'amorçage (pour les espaces de travail pré-remplis), définissez :

```json5
{ agent: { skipBootstrap: true } }
```

## Outils intégrés

Les outils de base (read/exec/edit/write et outils système connexes) sont toujours disponibles,
sous réserve de la politique d'outils. `apply_patch` est optionnel et contrôlé par
`tools.exec.applyPatch`. `TOOLS.md` ne contrôle **pas** quels outils existent ; c'est
un guide sur comment _vous_ voulez qu'ils soient utilisés.

## Compétences

OpenClaw charge les compétences depuis trois emplacements (l'espace de travail l'emporte en cas de conflit de nom) :

- Intégrées (livrées avec l'installation)
- Gérées/locales : `~/.openclaw/skills`
- Espace de travail : `<workspace>/skills`

Les compétences peuvent être contrôlées par config/env (voir `skills` dans [Configuration de la passerelle](/fr-FR/gateway/configuration)).

## Intégration pi-mono

OpenClaw réutilise des parties de la base de code pi-mono (modèles/outils), mais **la gestion des sessions, la découverte et le câblage des outils appartiennent à OpenClaw**.

- Pas d'environnement d'exécution d'agent pi-coding.
- Aucun paramètre `~/.pi/agent` ou `<workspace>/.pi` n'est consulté.

## Sessions

Les transcriptions de session sont stockées en JSONL à :

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

L'ID de session est stable et choisi par OpenClaw.
Les dossiers de session Pi/Tau hérités ne sont **pas** lus.

## Pilotage pendant le streaming

Quand le mode file d'attente est `steer`, les messages entrants sont injectés dans l'exécution actuelle.
La file d'attente est vérifiée **après chaque appel d'outil** ; si un message en file d'attente est présent,
les appels d'outils restants du message assistant actuel sont ignorés (résultats d'outils d'erreur avec "Ignoré en raison d'un message utilisateur en file d'attente."), puis le message utilisateur
en file d'attente est injecté avant la réponse assistant suivante.

Quand le mode file d'attente est `followup` ou `collect`, les messages entrants sont conservés jusqu'à ce que le
tour actuel se termine, puis un nouveau tour d'agent commence avec les charges en file d'attente. Voir
[File d'attente](/fr-FR/concepts/queue) pour le mode + comportement de debounce/cap.

Le streaming par blocs envoie les blocs assistant terminés dès qu'ils se terminent ; il est
**désactivé par défaut** (`agents.defaults.blockStreamingDefault: "off"`).
Ajustez la limite via `agents.defaults.blockStreamingBreak` (`text_end` vs `message_end` ; par défaut text_end).
Contrôlez le découpage de blocs souples avec `agents.defaults.blockStreamingChunk` (par défaut
800–1200 caractères ; préfère les sauts de paragraphe, puis les nouvelles lignes ; phrases en dernier).
Fusionnez les morceaux streamés avec `agents.defaults.blockStreamingCoalesce` pour réduire
le spam d'une seule ligne (fusion basée sur l'inactivité avant envoi). Les canaux non-Telegram nécessitent
`*.blockStreaming: true` explicite pour activer les réponses par blocs.
Les résumés d'outils verbeux sont émis au démarrage de l'outil (pas de debounce) ; l'Interface de contrôle
streame la sortie d'outil via les événements d'agent quand disponible.
Plus de détails : [Streaming + découpage](/fr-FR/concepts/streaming).

## Références de modèles

Les références de modèles dans la config (par exemple `agents.defaults.model` et `agents.defaults.models`) sont analysées en divisant sur le **premier** `/`.

- Utilisez `provider/model` lors de la configuration des modèles.
- Si l'ID de modèle lui-même contient `/` (style OpenRouter), incluez le préfixe du fournisseur (exemple : `openrouter/moonshotai/kimi-k2`).
- Si vous omettez le fournisseur, OpenClaw traite l'entrée comme un alias ou un modèle pour le **fournisseur par défaut** (ne fonctionne que quand il n'y a pas de `/` dans l'ID de modèle).

## Configuration (minimale)

Au minimum, définissez :

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (fortement recommandé)

---

_Suivant : [Chats de groupe](/fr-FR/channels/group-messages)_ 🦞
