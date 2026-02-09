---
title: Lobster
summary: "Runtime de workflow typé pour OpenClaw avec des portes d’approbation reprenables."
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - Vous souhaitez des workflows déterministes en plusieurs étapes avec des approbations explicites
  - Vous devez reprendre un workflow sans relancer les étapes précédentes
---

# Lobster

Lobster est un shell de workflow qui permet à OpenClaw d’exécuter des séquences d’outils en plusieurs étapes comme une seule opération déterministe, avec des points de contrôle d’approbation explicites.

## Hook

Votre assistant peut construire les outils qui se gèrent eux‑mêmes. Demandez un workflow et, 30 minutes plus tard, vous avez une CLI ainsi que des pipelines qui s’exécutent en un seul appel. Lobster est la pièce manquante : des pipelines déterministes, des approbations explicites et un état reprenable.

## Pourquoi

Aujourd’hui, les workflows complexes nécessitent de nombreux allers‑retours d’appels d’outils. Chaque appel consomme des tokens, et le LLM doit orchestrer chaque étape. Lobster déplace cette orchestration dans un runtime typé :

- **Un seul appel au lieu de plusieurs** : OpenClaw exécute un seul appel d’outil Lobster et obtient un résultat structuré.
- **Approbations intégrées** : les effets de bord (envoyer un e‑mail, publier un commentaire) interrompent le workflow jusqu’à une approbation explicite.
- **Reprenable** : les workflows interrompus renvoient un token ; approuvez et reprenez sans tout relancer.

## Pourquoi un DSL plutôt que des programmes classiques ?

Lobster est volontairement minimal. L’objectif n’est pas « un nouveau langage », mais une spécification de pipeline prévisible et adaptée à l’IA, avec des approbations et des tokens de reprise de première classe.

- **Approbation/reprise intégrées** : un programme classique peut solliciter un humain, mais il ne peut pas _mettre en pause et reprendre_ avec un token durable sans que vous n’inventiez vous‑même ce runtime.
- **Déterminisme + auditabilité** : les pipelines sont des données, donc faciles à journaliser, comparer, rejouer et examiner.
- **Surface contrainte pour l’IA** : une grammaire minuscule + du piping JSON réduit les chemins de code « créatifs » et rend la validation réaliste.
- **Politique de sécurité intégrée** : délais d’expiration, plafonds de sortie, vérifications de sandbox et allowlists sont imposés par le runtime, pas par chaque script.
- **Toujours programmable** : chaque étape peut appeler n’importe quelle CLI ou script. Si vous voulez du JS/TS, générez des fichiers `.lobster` à partir du code.

## Comment ça fonctionne

OpenClaw lance la CLI locale `lobster` en **mode outil** et analyse une enveloppe JSON depuis stdout.
Si le pipeline se met en pause pour approbation, l’outil renvoie un `resumeToken` afin que vous puissiez continuer plus tard.

## Modèle : petite CLI + pipes JSON + approbations

Construisez de petites commandes qui parlent JSON, puis enchaînez‑les dans un seul appel Lobster. (Noms de commandes d’exemple ci‑dessous — remplacez par les vôtres.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

Si le pipeline demande une approbation, reprenez avec le token :

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

L’IA déclenche le workflow ; Lobster exécute les étapes. Les portes d’approbation rendent les effets de bord explicites et auditables.

Exemple : mapper des éléments d’entrée vers des appels d’outils :

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## Étapes LLM uniquement JSON (llm-task)

Pour les workflows qui nécessitent une **étape LLM structurée**, activez l’outil plugin optionnel
`llm-task` et appelez‑le depuis Lobster. Cela maintient le workflow
déterministe tout en vous permettant de classifier/résumer/rédiger avec un modèle.

Activez l’outil :

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

Utilisez‑le dans un pipeline :

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

Voir [LLM Task](/tools/llm-task) pour les détails et options de configuration.

## Fichiers de workflow (.lobster)

Lobster peut exécuter des fichiers de workflow YAML/JSON avec les champs `name`, `args`, `steps`, `env`, `condition` et `approval`. Dans les appels d’outils OpenClaw, définissez `pipeline` sur le chemin du fichier.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Notes :

- `stdin: $step.stdout` et `stdin: $step.json` transmettent la sortie d’une étape précédente.
- `condition` (ou `when`) peut conditionner des étapes sur `$step.approved`.

## Installer Lobster

Installez la CLI Lobster sur le **même hôte** que celui qui exécute la Gateway (passerelle) OpenClaw (voir le [repo Lobster](https://github.com/openclaw/lobster)), et assurez‑vous que `lobster` est dans `PATH`.
Si vous souhaitez utiliser un emplacement binaire personnalisé, passez un `lobsterPath` **absolu** dans l’appel d’outil.

## Activez l’outil

Lobster est un outil plugin **optionnel** (désactivé par défaut).

Recommandé (additif, sûr) :

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Ou par agent :

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

Évitez d’utiliser `tools.allow: ["lobster"]` sauf si vous avez l’intention d’exécuter en mode allowlist restrictif.

Remarque : les allowlists sont opt‑in pour les plugins optionnels. Si votre allowlist ne nomme que
des outils plugin (comme `lobster`), OpenClaw conserve les outils de base activés. Pour restreindre les outils de base,
incluez aussi les outils ou groupes de base souhaités dans l’allowlist.

## Exemple : tri des e‑mails

Sans Lobster :

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

Avec Lobster :

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Renvoie une enveloppe JSON (tronquée) :

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

L’utilisateur approuve → reprise :

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Un seul workflow. Déterministe. Sûr.

## Paramètres de l'outil

### `run`

Exécuter un pipeline en mode outil.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Exécuter un fichier de workflow avec des arguments :

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Continuer un workflow interrompu après approbation.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Entrées optionnelles

- `lobsterPath` : chemin absolu vers le binaire Lobster (omettre pour utiliser `PATH`).
- `cwd` : répertoire de travail du pipeline (par défaut : répertoire de travail du processus courant).
- `timeoutMs` : tuer le sous‑processus s’il dépasse cette durée (par défaut : 20000).
- `maxStdoutBytes` : tuer le sous‑processus si stdout dépasse cette taille (par défaut : 512000).
- `argsJson` : chaîne JSON passée à `lobster run --args-json` (fichiers de workflow uniquement).

## Enveloppe de sortie

Lobster renvoie une enveloppe JSON avec l’un des trois statuts :

- `ok` → terminé avec succès
- `needs_approval` → en pause ; `requiresApproval.resumeToken` est requis pour reprendre
- `cancelled` → explicitement refusé ou annulé

L’outil expose l’enveloppe à la fois dans `content` (JSON formaté) et `details` (objet brut).

## Approbations

Si `requiresApproval` est présent, inspectez l’invite et décidez :

- `approve: true` → reprendre et poursuivre les effets de bord
- `approve: false` → annuler et finaliser le workflow

Utilisez `approve --preview-from-stdin --limit N` pour joindre un aperçu JSON aux demandes d’approbation sans bricolage jq/heredoc personnalisé. Les tokens de reprise sont désormais compacts : Lobster stocke l’état de reprise du workflow sous son répertoire d’état et renvoie une petite clé de token.

## OpenProse

OpenProse s’associe bien avec Lobster : utilisez `/prose` pour orchestrer la préparation multi‑agents, puis exécutez un pipeline Lobster pour des approbations déterministes. Si un programme Prose a besoin de Lobster, autorisez l’outil `lobster` pour les sous‑agents via `tools.subagents.tools`. Voir [OpenProse](/prose).

## Sécurité

- **Sous‑processus local uniquement** — aucun appel réseau depuis le plugin lui‑même.
- **Aucun secret** — Lobster ne gère pas OAuth ; il appelle des outils OpenClaw qui s’en chargent.
- **Compatible sandbox** — désactivé lorsque le contexte de l’outil est en sandbox.
- **Renforcé** — `lobsterPath` doit être absolu s’il est spécifié ; délais et plafonds de sortie appliqués.

## Problemes courants

- **`lobster subprocess timed out`** → augmentez `timeoutMs` ou scindez un pipeline long.
- **`lobster output exceeded maxStdoutBytes`** → augmentez `maxStdoutBytes` ou réduisez la taille de la sortie.
- **`lobster returned invalid JSON`** → assurez‑vous que le pipeline s’exécute en mode outil et n’imprime que du JSON.
- **`lobster failed (code …)`** → exécutez le même pipeline dans un terminal pour inspecter stderr.

## En savoir plus

- [Plugins](/plugin)
- [Création d’outils plugin](/plugins/agent-tools)

## Étude de cas : workflows communautaires

Un exemple public : une CLI de « second cerveau » + des pipelines Lobster qui gèrent trois coffres Markdown (personnel, partenaire, partagé). La CLI émet du JSON pour les statistiques, les listes de boîte de réception et les analyses d’obsolescence ; Lobster enchaîne ces commandes en workflows comme `weekly-review`, `inbox-triage`, `memory-consolidation` et `shared-task-sync`, chacun avec des portes d’approbation. L’IA gère le jugement (catégorisation) lorsqu’elle est disponible et se replie sur des règles déterministes sinon.

- Fil : https://x.com/plattenschieber/status/2014508656335770033
- Repo : https://github.com/bloomedai/brain-cli
