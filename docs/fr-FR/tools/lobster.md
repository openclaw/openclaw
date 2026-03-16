---
title: Lobster
summary: "Runtime workflow typé pour OpenClaw avec gates approbation reprenables."
description: Runtime workflow typé pour OpenClaw — pipelines composables avec gates approbation.
read_when:
  - Vous voulez workflows multi-étapes déterministes avec approbations explicites
  - Vous devez reprendre un workflow sans ré-exécuter les étapes précédentes
---

# Lobster

Lobster est un shell workflow qui permet à OpenClaw d'exécuter des séquences outils multi-étapes comme une seule opération déterministe avec points contrôle approbation explicites.

## Hook

Votre assistant peut construire les outils qui se gèrent eux-mêmes. Demandez un workflow, et 30 minutes plus tard vous avez un CLI plus pipelines qui s'exécutent comme un seul appel. Lobster est la pièce manquante : pipelines déterministes, approbations explicites et état reprenible.

## Pourquoi

Aujourd'hui, les workflows complexes nécessitent de nombreux appels outils aller-retour. Chaque appel coûte des jetons, et le LLM doit orchestrer chaque étape. Lobster déplace cette orchestration dans un runtime typé :

- **Un appel au lieu de plusieurs** : OpenClaw exécute un appel outil Lobster et obtient un résultat structuré.
- **Approbations intégrées** : Les effets secondaires (envoyer email, poster commentaire) arrêtent le workflow jusqu'à approbation explicite.
- **Reprenible** : Les workflows arrêtés retournent un jeton ; approuvez et reprenez sans tout ré-exécuter.

## Pourquoi un DSL au lieu de programmes simples ?

Lobster est intentionnellement petit. L'objectif n'est pas "un nouveau langage", c'est une spec pipeline prévisible, compatible IA avec approbations first-class et jetons reprise.

- **Approuver/reprendre est intégré** : Un programme normal peut solliciter un humain, mais il ne peut pas _pause et reprendre_ avec un jeton durable sans que vous n'inventiez ce runtime vous-même.
- **Déterminisme + auditabilité** : Les pipelines sont des données, donc ils sont faciles à logger, diff, replay et review.
- **Surface contrainte pour IA** : Une grammaire minuscule + piping JSON réduit les chemins code "créatifs" et rend la validation réaliste.
- **Politique sécurité intégrée** : Timeouts, caps sortie, vérifications sandbox et allowlists sont appliqués par le runtime, pas chaque script.
- **Toujours programmable** : Chaque étape peut appeler n'importe quel CLI ou script. Si vous voulez JS/TS, générez des fichiers `.lobster` depuis du code.

## Comment ça marche

OpenClaw lance le CLI `lobster` local en **mode outil** et parse une enveloppe JSON depuis stdout.
Si le pipeline pause pour approbation, l'outil retourne un `resumeToken` donc vous pouvez continuer plus tard.

## Pattern : petit CLI + pipes JSON + approbations

Construisez des commandes minuscules qui parlent JSON, puis chaînez-les dans un seul appel Lobster. (Noms commandes exemples ci-dessous — échangez-les avec les vôtres.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Appliquer les changements ?'",
  "timeoutMs": 30000
}
```

Si le pipeline demande approbation, reprenez avec le jeton :

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

L'IA déclenche le workflow ; Lobster exécute les étapes. Les gates approbation gardent les effets secondaires explicites et auditables.

Exemple : mapper les éléments entrée dans les appels outils :

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## Étapes LLM JSON uniquement (llm-task)

Pour les workflows qui ont besoin d'une **étape LLM structurée**, activez l'outil
plugin `llm-task` optionnel et appelez-le depuis Lobster. Cela garde le workflow
déterministe tout en vous permettant toujours de classifier/résumer/brouillonner avec un modèle.

Activez l'outil :

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

Utilisez-le dans un pipeline :

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Étant donné l'email entrée, retourner intent et brouillon.",
  "input": { "subject": "Bonjour", "body": "Pouvez-vous aider ?" },
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

Voir [LLM Task](/fr-FR/tools/llm-task) pour détails et options configuration.

## Fichiers workflow (.lobster)

Lobster peut exécuter des fichiers workflow YAML/JSON avec champs `name`, `args`, `steps`, `env`, `condition` et `approval`. Dans les appels outils OpenClaw, définissez `pipeline` vers le chemin fichier.

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

Notes :

- `stdin: $step.stdout` et `stdin: $step.json` passent la sortie d'une étape précédente.
- `condition` (ou `when`) peut gater des étapes sur `$step.approved`.

## Installer Lobster

Installez le CLI Lobster sur le **même hôte** qui exécute la Passerelle OpenClaw (voir le [repo Lobster](https://github.com/openclaw/lobster)), et assurez-vous que `lobster` est sur `PATH`.
Si vous voulez utiliser un emplacement binaire personnalisé, passez un `lobsterPath` **absolu** dans l'appel outil.

## Activer l'outil

Lobster est un outil plugin **optionnel** (pas activé par défaut).

Recommandé (additif, sûr) :

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Ou par agent :

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

Évitez d'utiliser `tools.allow: ["lobster"]` sauf si vous avez l'intention d'exécuter en mode allowlist restrictif.

Note : les allowlists sont opt-in pour les plugins optionnels. Si votre allowlist nomme uniquement
des outils plugin (comme `lobster`), OpenClaw garde les outils core activés. Pour restreindre les
outils core, incluez aussi les outils ou groupes core que vous voulez dans l'allowlist.

## Exemple : Triage email

Sans Lobster :

```
Utilisateur : "Vérifier mes emails et brouillonner réponses"
→ openclaw appelle gmail.list
→ LLM résume
→ Utilisateur : "brouillonner réponses à #2 et #5"
→ LLM brouillonne
→ Utilisateur : "envoyer #2"
→ openclaw appelle gmail.send
(répéter quotidiennement, pas de mémoire de ce qui a été trié)
```

Avec Lobster :

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Retourne une enveloppe JSON (tronquée) :

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 nécessitent réponses, 2 nécessitent action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Envoyer 2 brouillons réponses ?",
    "items": [],
    "resumeToken": "..."
  }
}
```

Utilisateur approuve → reprend :

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Un workflow. Déterministe. Sûr.

## Paramètres outil

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

Exécuter un fichier workflow avec args :

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Continuer un workflow arrêté après approbation.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Entrées optionnelles

- `lobsterPath` : Chemin absolu vers le binaire Lobster (omettre pour utiliser `PATH`).
- `cwd` : Répertoire travail pour le pipeline (défaut au répertoire travail processus actuel).
- `timeoutMs` : Tuer le subprocess s'il dépasse cette durée (défaut : 20000).
- `maxStdoutBytes` : Tuer le subprocess si stdout dépasse cette taille (défaut : 512000).
- `argsJson` : Chaîne JSON passée à `lobster run --args-json` (fichiers workflow uniquement).

## Enveloppe sortie

Lobster retourne une enveloppe JSON avec l'un de trois statuts :

- `ok` → terminé avec succès
- `needs_approval` → pausé ; `requiresApproval.resumeToken` est requis pour reprendre
- `cancelled` → explicitement refusé ou annulé

L'outil expose l'enveloppe dans `content` (JSON joli) et `details` (objet brut).

## Approbations

Si `requiresApproval` est présent, inspectez le prompt et décidez :

- `approve: true` → reprendre et continuer les effets secondaires
- `approve: false` → annuler et finaliser le workflow

Utilisez `approve --preview-from-stdin --limit N` pour attacher un aperçu JSON aux demandes approbation sans colle jq/heredoc personnalisée. Les jetons reprise sont maintenant compacts : Lobster stocke l'état reprise workflow sous son dir état et retourne une petite clé jeton.

## OpenProse

OpenProse se marie bien avec Lobster : utilisez `/prose` pour orchestrer la préparation multi-agent, puis exécutez un pipeline Lobster pour approbations déterministes. Si un programme Prose a besoin de Lobster, autorisez l'outil `lobster` pour les sous-agents via `tools.subagents.tools`. Voir [OpenProse](/fr-FR/prose).

## Sécurité

- **Subprocess local uniquement** — pas d'appels réseau depuis le plugin lui-même.
- **Pas de secrets** — Lobster ne gère pas OAuth ; il appelle les outils OpenClaw qui le font.
- **Conscient sandbox** — désactivé quand le contexte outil est sandboxé.
- **Durci** — `lobsterPath` doit être absolu si spécifié ; timeouts et caps sortie appliqués.

## Dépannage

- **`lobster subprocess timed out`** → augmentez `timeoutMs`, ou divisez un pipeline long.
- **`lobster output exceeded maxStdoutBytes`** → augmentez `maxStdoutBytes` ou réduisez la taille sortie.
- **`lobster returned invalid JSON`** → assurez-vous que le pipeline s'exécute en mode outil et affiche uniquement JSON.
- **`lobster failed (code …)`** → exécutez le même pipeline dans un terminal pour inspecter stderr.

## En savoir plus

- [Plugins](/fr-FR/tools/plugin)
- [Création outils agent Plugin](/fr-FR/plugins/agent-tools)

## Étude de cas : workflows communauté

Un exemple public : un CLI "second cerveau" + pipelines Lobster qui gèrent trois vaults Markdown (personnel, partenaire, partagé). Le CLI émet JSON pour stats, listings inbox et scans périmés ; Lobster chaîne ces commandes dans des workflows comme `weekly-review`, `inbox-triage`, `memory-consolidation` et `shared-task-sync`, chacun avec des gates approbation. L'IA gère le jugement (catégorisation) quand disponible et retombe sur des règles déterministes quand non.

- Thread : [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo : [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
