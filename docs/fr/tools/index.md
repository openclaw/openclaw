---
summary: "Surface des outils d’agent pour OpenClaw (navigateur, canvas, nœuds, messages, cron) remplaçant les anciens Skills `openclaw-*`"
read_when:
  - Ajout ou modification d’outils d’agent
  - Retrait ou modification des Skills `openclaw-*`
title: "Outils"
---

# Tools (OpenClaw)

OpenClaw expose des **outils d’agent de premier ordre** pour le navigateur, le canvas, les nœuds et cron.
Ils remplacent les anciens Skills `openclaw-*` : les outils sont typés, sans exécution via shell,
et l’agent doit s’appuyer directement sur eux.

## Désactivation des outils

Vous pouvez autoriser/interdire globalement les outils via `tools.allow` / `tools.deny` dans `openclaw.json`
(l’interdiction l’emporte). Cela empêche l’envoi d’outils non autorisés aux fournisseurs de modèles.

```json5
{
  tools: { deny: ["browser"] },
}
```

Notes :

- La correspondance est insensible à la casse.
- Les jokers `*` sont pris en charge (`"*"` signifie tous les outils).
- Si `tools.allow` ne référence que des noms d’outils de plugins inconnus ou non chargés, OpenClaw consigne un avertissement et ignore la liste d’autorisation afin que les outils cœur restent disponibles.

## Profils d’outils (liste d’autorisation de base)

`tools.profile` définit une **liste d’autorisation d’outils de base** avant `tools.allow`/`tools.deny`.
Surcharge par agent : `agents.list[].tools.profile`.

Profils :

- `minimal` : `session_status` uniquement
- `coding` : `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging` : `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full` : aucune restriction (identique à non défini)

Exemple (messagerie uniquement par défaut, autoriser aussi les outils Slack + Discord) :

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Exemple (profil de codage, mais interdire exec/process partout) :

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Exemple (profil de codage global, agent de support messagerie uniquement) :

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

## Politique d’outils spécifique au fournisseur

Utilisez `tools.byProvider` pour **restreindre davantage** les outils pour des fournisseurs spécifiques
(ou un seul `provider/model`) sans modifier vos valeurs globales.
Surcharge par agent : `agents.list[].tools.byProvider`.

Ceci est appliqué **après** le profil d’outils de base et **avant** les listes autoriser/interdire,
il ne peut donc que réduire l’ensemble d’outils.
Les clés de fournisseur acceptent soit `provider` (par ex. `google-antigravity`), soit
`provider/model` (par ex. `openai/gpt-5.2`).

Exemple (conserver le profil de codage global, mais outils minimaux pour Google Antigravity) :

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Exemple (liste d’autorisation fournisseur/modèle pour un point de terminaison instable) :

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

Exemple (surcharge spécifique à un agent pour un seul fournisseur) :

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Groupes d’outils (raccourcis)

Les politiques d’outils (globales, agent, sandbox) prennent en charge des entrées `group:*` qui se développent en plusieurs outils.
Utilisez-les dans `tools.allow` / `tools.deny`.

Groupes disponibles :

- `group:runtime` : `exec`, `bash`, `process`
- `group:fs` : `read`, `write`, `edit`, `apply_patch`
- `group:sessions` : `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory` : `memory_search`, `memory_get`
- `group:web` : `web_search`, `web_fetch`
- `group:ui` : `browser`, `canvas`
- `group:automation` : `cron`, `gateway`
- `group:messaging` : `message`
- `group:nodes` : `nodes`
- `group:openclaw` : tous les outils OpenClaw intégrés (exclut les plugins de fournisseur)

Exemple (autoriser uniquement les outils de fichiers + navigateur) :

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugins + outils

Les plugins peuvent enregistrer des **outils supplémentaires** (et des commandes CLI) au-delà de l’ensemble cœur.
Voir [Plugins](/plugin) pour l’installation + la configuration, et [Skills](/tools/skills) pour savoir comment
les consignes d’utilisation des outils sont injectées dans les prompts. Certains plugins livrent leurs propres Skills
en plus des outils (par exemple, le plugin d’appel vocal).

Outils de plugins optionnels :

- [Lobster](/tools/lobster) : moteur de workflow typé avec validations reprises (nécessite le CLI Lobster sur l’hôte de la Gateway (passerelle)).
- [LLM Task](/tools/llm-task) : étape LLM JSON uniquement pour une sortie de workflow structurée (validation de schéma optionnelle).

## Inventaire des outils

### `apply_patch`

Appliquer des correctifs structurés sur un ou plusieurs fichiers. À utiliser pour des modifications multi-hunks.
Expérimental : activer via `tools.exec.applyPatch.enabled` (modèles OpenAI uniquement).

### `exec`

Exécuter des commandes shell dans l’espace de travail.

Paramètres principaux :

- `command` (requis)
- `yieldMs` (passage automatique en arrière-plan après délai, par défaut 10000)
- `background` (arrière-plan immédiat)
- `timeout` (secondes ; tue le processus si dépassé, par défaut 1800)
- `elevated` (bool ; exécuter sur l’hôte si le mode élevé est activé/autorisé ; ne change le comportement que lorsque l’agent est en sandbox)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (id/nom de nœud pour `host=node`)
- Besoin d’un vrai TTY ? Définissez `pty: true`.

Notes :

- Renvoie `status: "running"` avec un `sessionId` lorsqu’il est en arrière-plan.
- Utilisez `process` pour sonder/journaliser/écrire/arrêter/effacer les sessions en arrière-plan.
- Si `process` est interdit, `exec` s’exécute de manière synchrone et ignore `yieldMs`/`background`.
- `elevated` est contrôlé par `tools.elevated` plus toute surcharge `agents.list[].tools.elevated` (les deux doivent autoriser) et est un alias pour `host=gateway` + `security=full`.
- `elevated` ne change le comportement que lorsque l’agent est en sandbox (sinon, sans effet).
- `host=node` peut cibler une application compagnon macOS ou un hôte de nœud sans interface (`openclaw node run`).
- approbations et listes d’autorisation gateway/nœud : [Exec approvals](/tools/exec-approvals).

### `process`

Gérer les sessions exec en arrière-plan.

Actions principales :

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Notes :

- `poll` renvoie la nouvelle sortie et le statut de sortie une fois terminé.
- `log` prend en charge le suivi par lignes `offset`/`limit` (omettre `offset` pour récupérer les N dernières lignes).
- `process` est limité par agent ; les sessions d’autres agents ne sont pas visibles.

### `web_search`

Rechercher sur le Web via l’API Brave Search.

Paramètres principaux :

- `query` (requis)
- `count` (1–10 ; valeur par défaut depuis `tools.web.search.maxResults`)

Notes :

- Nécessite une clé API Brave (recommandé : `openclaw configure --section web`, ou définir `BRAVE_API_KEY`).
- Activer via `tools.web.search.enabled`.
- Les réponses sont mises en cache (15 min par défaut).
- Voir [Web tools](/tools/web) pour la configuration.

### `web_fetch`

Récupérer et extraire un contenu lisible depuis une URL (HTML → markdown/texte).

Paramètres principaux :

- `url` (requis)
- `extractMode` (`markdown` | `text`)
- `maxChars` (tronquer les pages longues)

Notes :

- Activer via `tools.web.fetch.enabled`.
- `maxChars` est plafonné par `tools.web.fetch.maxCharsCap` (par défaut 50000).
- Les réponses sont mises en cache (15 min par défaut).
- Pour les sites fortement dépendants de JS, privilégiez l’outil navigateur.
- Voir [Web tools](/tools/web) pour la configuration.
- Voir [Firecrawl](/tools/firecrawl) pour le repli anti-bot optionnel.

### `browser`

Contrôler le navigateur dédié géré par OpenClaw.

Actions principales :

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (renvoie un bloc image + `MEDIA:<path>`)
- `act` (actions UI : click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Gestion des profils :

- `profiles` — lister tous les profils de navigateur avec statut
- `create-profile` — créer un nouveau profil avec port alloué automatiquement (ou `cdpUrl`)
- `delete-profile` — arrêter le navigateur, supprimer les données utilisateur, retirer de la configuration (local uniquement)
- `reset-profile` — tuer un processus orphelin sur le port du profil (local uniquement)

Paramètres communs :

- `profile` (optionnel ; par défaut `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (optionnel ; sélectionner un id/nom de nœud spécifique)
  Notes :
- Nécessite `browser.enabled=true` (par défaut `true` ; définir `false` pour désactiver).
- Toutes les actions acceptent un paramètre optionnel `profile` pour le support multi‑instances.
- Lorsque `profile` est omis, utilise `browser.defaultProfile` (par défaut « chrome »).
- Noms de profil : alphanumérique en minuscules + tirets uniquement (64 caractères max).
- Plage de ports : 18800‑18899 (~100 profils max).
- Les profils distants sont en attachement uniquement (pas de start/stop/reset).
- Si un nœud compatible navigateur est connecté, l’outil peut s’y router automatiquement (sauf si vous épinglez `target`).
- `snapshot` par défaut `ai` lorsque Playwright est installé ; utilisez `aria` pour l’arbre d’accessibilité.
- `snapshot` prend aussi en charge des options d’instantané de rôles (`interactive`, `compact`, `depth`, `selector`) qui renvoient des références comme `e12`.
- `act` nécessite `ref` depuis `snapshot` (numérique `12` depuis les instantanés IA, ou `e12` depuis les instantanés de rôles) ; utilisez `evaluate` pour de rares besoins de sélecteur CSS.
- Évitez `act` → `wait` par défaut ; utilisez‑le uniquement dans des cas exceptionnels (aucun état UI fiable sur lequel attendre).
- `upload` peut optionnellement transmettre un `ref` pour cliquer automatiquement après armement.
- `upload` prend aussi en charge `inputRef` (réf aria) ou `element` (sélecteur CSS) pour définir directement `<input type="file">`.

### `canvas`

Piloter le Canvas du nœud (present, eval, snapshot, A2UI).

Actions principales :

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (renvoie un bloc image + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Notes :

- Utilise la `node.invoke` de la Gateway (passerelle) en interne.
- Si aucun `node` n’est fourni, l’outil choisit une valeur par défaut (nœud unique connecté ou nœud mac local).
- A2UI est en v0.8 uniquement (pas de `createSurface`) ; la CLI rejette les JSONL v0.9 avec des erreurs de ligne.
- Test rapide : `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Découvrir et cibler des nœuds appairés ; envoyer des notifications ; capturer caméra/écran.

Actions principales :

- `status`, `describe`
- `pending`, `approve`, `reject` (appairage)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Notes :

- Les commandes caméra/écran nécessitent que l’application du nœud soit au premier plan.
- Les images renvoient des blocs image + `MEDIA:<path>`.
- Les vidéos renvoient `FILE:<path>` (mp4).
- La localisation renvoie une charge utile JSON (lat/lon/précision/horodatage).
- Paramètres `run` : tableau argv `command` ; `cwd` optionnel, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Exemple (`run`) :

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Analyser une image avec le modèle d’image configuré.

Paramètres principaux :

- `image` (chemin ou URL requis)
- `prompt` (optionnel ; par défaut « Describe the image. »)
- `model` (surcharge optionnelle)
- `maxBytesMb` (plafond de taille optionnel)

Notes :

- Disponible uniquement lorsque `agents.defaults.imageModel` est configuré (principal ou secours), ou lorsqu’un modèle d’image implicite peut être déduit de votre modèle par défaut + authentification configurée (appariement au mieux).
- Utilise directement le modèle d’image (indépendant du modèle de chat principal).

### `message`

Envoyer des messages et actions de canal sur Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Actions principales :

- `send` (texte + média optionnel ; MS Teams prend aussi en charge `card` pour les Adaptive Cards)
- `poll` (sondages WhatsApp/Discord/MS Teams)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

Notes :

- `send` route WhatsApp via la Gateway (passerelle) ; les autres canaux vont directement.
- `poll` utilise la Gateway (passerelle) pour WhatsApp et MS Teams ; les sondages Discord vont directement.
- Lorsqu’un appel d’outil de messagerie est lié à une session de chat active, les envois sont contraints à la cible de cette session afin d’éviter les fuites inter‑contexte.

### `cron`

Gérer les tâches cron et réveils de la Gateway (passerelle).

Actions principales :

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (mettre en file un événement système + battement immédiat optionnel)

Notes :

- `add` attend un objet de tâche cron complet (même schéma que l’RPC `cron.add`).
- `update` utilise `{ id, patch }`.

### `gateway`

Redémarrer ou appliquer des mises à jour au processus Gateway (passerelle) en cours (sur place).

Actions principales :

- `restart` (autorise + envoie `SIGUSR1` pour redémarrage en processus ; `openclaw gateway` redémarrage sur place)
- `config.get` / `config.schema`
- `config.apply` (valider + écrire la configuration + redémarrer + réveiller)
- `config.patch` (fusionner une mise à jour partielle + redémarrer + réveiller)
- `update.run` (exécuter la mise à jour + redémarrer + réveiller)

Notes :

- Utilisez `delayMs` (par défaut 2000) pour éviter d’interrompre une réponse en cours.
- `restart` est désactivé par défaut ; activez‑le avec `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Lister les sessions, inspecter l’historique des transcriptions, ou envoyer vers une autre session.

Paramètres principaux :

- `sessions_list` : `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = aucun)
- `sessions_history` : `sessionKey` (ou `sessionId`), `limit?`, `includeTools?`
- `sessions_send` : `sessionKey` (ou `sessionId`), `message`, `timeoutSeconds?` (0 = fire‑and‑forget)
- `sessions_spawn` : `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status` : `sessionKey?` (par défaut courant ; accepte `sessionId`), `model?` (`default` efface la surcharge)

Notes :

- `main` est la clé canonique de chat direct ; global/inconnu sont masqués.
- `messageLimit > 0` récupère les N derniers messages par session (messages d’outils filtrés).
- `sessions_send` attend l’achèvement final lorsque `timeoutSeconds > 0`.
- La livraison/l’annonce intervient après l’achèvement et est au mieux ; `status: "ok"` confirme la fin de l’exécution de l’agent, pas la livraison de l’annonce.
- `sessions_spawn` démarre une exécution de sous‑agent et publie une réponse d’annonce dans le chat demandeur.
- `sessions_spawn` est non bloquant et renvoie immédiatement `status: "accepted"`.
- `sessions_send` exécute un ping‑pong de réponse (répondre `REPLY_SKIP` pour arrêter ; nombre maximal de tours via `session.agentToAgent.maxPingPongTurns`, 0–5).
- Après le ping‑pong, l’agent cible exécute une **étape d’annonce** ; répondre `ANNOUNCE_SKIP` pour supprimer l’annonce.

### `agents_list`

Lister les identifiants d’agent que la session courante peut cibler avec `sessions_spawn`.

Notes :

- Le résultat est limité aux listes d’autorisation par agent (`agents.list[].subagents.allowAgents`).
- Lorsque `["*"]` est configuré, l’outil inclut tous les agents configurés et marque `allowAny: true`.

## Paramètres (communs)

Outils adossés à la Gateway (passerelle) (`canvas`, `nodes`, `cron`) :

- `gatewayUrl` (par défaut `ws://127.0.0.1:18789`)
- `gatewayToken` (si l’authentification est activée)
- `timeoutMs`

Note : lorsque `gatewayUrl` est défini, incluez explicitement `gatewayToken`. Les outils n’héritent pas de la configuration
ni des identifiants d’environnement pour les surcharges, et l’absence d’identifiants explicites est une erreur.

Outil navigateur :

- `profile` (optionnel ; par défaut `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (optionnel ; épingler un id/nom de nœud spécifique)

## Flux d’agent recommandés

Automatisation du navigateur :

1. `browser` → `status` / `start`
2. `snapshot` (ai ou aria)
3. `act` (click/type/press)
4. `screenshot` si vous avez besoin d’une confirmation visuelle

Rendu Canvas :

1. `canvas` → `present`
2. `a2ui_push` (optionnel)
3. `snapshot`

Ciblage des nœuds:

1. `nodes` → `status`
2. `describe` sur le nœud choisi
3. `notify` / `run` / `camera_snap` / `screen_record`

## Sécurité

- Évitez `system.run` direct ; utilisez `nodes` → `run` uniquement avec le consentement explicite de l’utilisateur.
- Respectez le consentement de l’utilisateur pour la capture caméra/écran.
- Utilisez `status/describe` pour vérifier les autorisations avant d’invoquer des commandes média.

## Comment les outils sont présentés à l’agent

Les outils sont exposés dans deux canaux parallèles :

1. **Texte du prompt système** : une liste lisible par un humain + des consignes.
2. **Schéma d’outil** : les définitions de fonctions structurées envoyées à l’API du modèle.

Cela signifie que l’agent voit à la fois « quels outils existent » et « comment les appeler ». Si un outil
n’apparaît pas dans le prompt système ou dans le schéma, le modèle ne peut pas l’appeler.
