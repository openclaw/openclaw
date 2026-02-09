---
summary: "Runtime de l’agent (pi-mono embarqué), contrat d’espace de travail et amorçage de session"
read_when:
  - Modification du runtime de l’agent, de l’amorçage de l’espace de travail ou du comportement de session
title: "Runtime de l’agent"
---

# Runtime de l’agent 🤖

OpenClaw exécute un runtime d’agent embarqué unique dérivé de **pi-mono**.

## Espace de travail (requis)

OpenClaw utilise un unique répertoire d’espace de travail de l’agent (`agents.defaults.workspace`) comme **seul** répertoire de travail (`cwd`) pour les outils et le contexte.

Recommandé : utiliser `openclaw setup` pour créer `~/.openclaw/openclaw.json` s’il est absent et initialiser les fichiers de l’espace de travail.

Disposition complète de l’espace de travail + guide de sauvegarde : [Espace de travail de l’agent](/concepts/agent-workspace)

Si `agents.defaults.sandbox` est activé, les sessions non principales peuvent remplacer ce comportement par des espaces de travail par session sous `agents.defaults.sandbox.workspaceRoot` (voir
[Configuration de la Gateway (passerelle)](/gateway/configuration)).

## Fichiers d’amorçage (injectés)

À l’intérieur de `agents.defaults.workspace`, OpenClaw attend les fichiers modifiables par l’utilisateur suivants :

- `AGENTS.md` — instructions de fonctionnement + « mémoire »
- `SOUL.md` — persona, limites, ton
- `TOOLS.md` — notes d’outils maintenues par l’utilisateur (p. ex. `imsg`, `sag`, conventions)
- `BOOTSTRAP.md` — rituel de première exécution unique (supprimé après achèvement)
- `IDENTITY.md` — nom/vibe/emoji de l’agent
- `USER.md` — profil utilisateur + forme d’adresse préférée

Au premier tour d’une nouvelle session, OpenClaw injecte directement le contenu de ces fichiers dans le contexte de l’agent.

Les fichiers vides sont ignorés. Les fichiers volumineux sont rognés et tronqués avec un marqueur afin de conserver des invites légères (lisez le fichier pour le contenu complet).

Si un fichier est manquant, OpenClaw injecte une seule ligne de marqueur « fichier manquant » (et `openclaw setup` créera un modèle par défaut sûr).

`BOOTSTRAP.md` n’est créé que pour un **tout nouvel espace de travail** (aucun autre fichier d’amorçage présent). Si vous le supprimez après avoir terminé le rituel, il ne doit pas être recréé lors des redémarrages ultérieurs.

Pour désactiver entièrement la création des fichiers d’amorçage (pour des espaces de travail préensemencés), définissez :

```json5
{ agent: { skipBootstrap: true } }
```

## Outils intégrés

Les outils de base (lecture/exécution/édition/écriture et outils système associés) sont toujours disponibles, sous réserve de la politique des outils. `apply_patch` est facultatif et contrôlé par
`tools.exec.applyPatch`. `TOOLS.md` ne contrôle **pas** quels outils existent ; il sert de
guide sur la manière dont _vous_ souhaitez qu’ils soient utilisés.

## Skills

OpenClaw charge les Skills depuis trois emplacements (l’espace de travail l’emporte en cas de conflit de nom) :

- Intégrés (fournis avec l’installation)
- Gérés/locaux : `~/.openclaw/skills`
- Espace de travail : `<workspace>/skills`

Les Skills peuvent être contrôlés par configuration/variables d’environnement (voir `skills` dans [Configuration de la Gateway (passerelle)](/gateway/configuration)).

## Intégration pi-mono

OpenClaw réutilise des éléments de la base de code pi-mono (modèles/outils), mais **la gestion des sessions, la découverte et le câblage des outils sont propres à OpenClaw**.

- Pas de runtime d’agent pi-coding.
- Aucun paramètre `~/.pi/agent` ou `<workspace>/.pi` n’est consulté.

## Sessions

Les transcriptions de session sont stockées en JSONL à l’emplacement :

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

L’ID de session est stable et choisi par OpenClaw.
Les dossiers de session hérités Pi/Tau ne sont **pas** lus.

## Pilotage pendant le streaming

Lorsque le mode de file d’attente est `steer`, les messages entrants sont injectés dans l’exécution en cours.
La file est vérifiée **après chaque appel d’outil** ; si un message en file est présent,
les appels d’outils restants du message assistant courant sont ignorés (résultats d’outil en erreur avec « Skipped due to queued user message.

Lorsque le mode de file d’attente est `followup` ou `collect`, les messages entrants sont conservés jusqu’à la fin du tour en cours, puis un nouveau tour d’agent démarre avec les charges utiles en file. Voir
[File d’attente](/concepts/queue) pour les modes + le comportement de debounce/cap.

Le streaming par blocs envoie les blocs d’assistant terminés dès qu’ils sont prêts ; il est
**désactivé par défaut** (`agents.defaults.blockStreamingDefault: "off"`).
Réglez la frontière via `agents.defaults.blockStreamingBreak` (`text_end` vs `message_end` ; valeur par défaut : text_end).
Contrôlez le découpage souple des blocs avec `agents.defaults.blockStreamingChunk` (par défaut
800–1200 caractères ; privilégie les coupures de paragraphe, puis les retours à la ligne ; les phrases en dernier).
Regroupez les segments streamés avec `agents.defaults.blockStreamingCoalesce` afin de réduire
le spam de lignes uniques (fusion basée sur l’inactivité avant envoi). Les canaux non Telegram
nécessitent un `*.blockStreaming: true` explicite pour activer les réponses par blocs.
Des résumés d’outils détaillés sont émis au démarrage de l’outil (sans debounce) ; l’interface de contrôle
streame la sortie des outils via des événements d’agent lorsqu’ils sont disponibles.
Plus de détails : [Streaming + découpage](/concepts/streaming).

## Références de modèle

Les références de modèle dans la configuration (par exemple `agents.defaults.model` et `agents.defaults.models`) sont analysées en scindant sur le **premier** `/`.

- Utilisez `provider/model` lors de la configuration des modèles.
- Si l’ID du modèle contient lui‑même `/` (style OpenRouter), incluez le préfixe du fournisseur (exemple : `openrouter/moonshotai/kimi-k2`).
- Si vous omettez le fournisseur, OpenClaw traite l’entrée comme un alias ou un modèle pour le **fournisseur par défaut** (ne fonctionne que lorsqu’il n’y a pas de `/` dans l’ID du modèle).

## Configuration (minimale)

Au minimum, définissez :

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (fortement recommandé)

---

_Suivant : [Conversations de groupe](/concepts/group-messages)_ 🦞
