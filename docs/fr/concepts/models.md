---
summary: "CLI des modeles : lister, definir, alias, replis, scan, statut"
read_when:
  - Ajout ou modification de la CLI des modeles (models list/set/scan/aliases/fallbacks)
  - Changement du comportement de repli des modeles ou de l’UX de selection
  - Mise a jour des sondes de scan des modeles (outils/images)
title: "CLI des modeles"
---

# CLI des modeles

Voir [/concepts/model-failover](/concepts/model-failover) pour la rotation des profils d’authentification,
les delais de refroidissement et la facon dont cela interagit avec les replis.
Apercu rapide des fournisseurs + exemples : [/concepts/model-providers](/concepts/model-providers).

## Comment fonctionne la selection de modele

OpenClaw selectionne les modeles dans cet ordre :

1. **Principal** (`agents.defaults.model.primary` ou `agents.defaults.model`).
2. **Replis** dans `agents.defaults.model.fallbacks` (dans l’ordre).
3. **Basculement d’authentification du fournisseur** a lieu a l’interieur d’un fournisseur avant de passer au
   modele suivant.

Liens associés :

- `agents.defaults.models` est la liste d’autorisation/catalogue des modeles qu’OpenClaw peut utiliser (plus les alias).
- `agents.defaults.imageModel` est utilise **uniquement lorsque** le modele principal ne peut pas accepter d’images.
- Les valeurs par defaut par agent peuvent remplacer `agents.defaults.model` via `agents.list[].model` plus des liaisons (voir [/concepts/multi-agent](/concepts/multi-agent)).

## Choix rapides de modeles (anecdotiques)

- **GLM** : un peu meilleur pour le code et l’appel d’outils.
- **MiniMax** : meilleur pour l’ecriture et l’ambiance.

## Assistant de configuration (recommande)

Si vous ne souhaitez pas modifier la configuration a la main, lancez l’assistant de prise en main :

```bash
openclaw onboard
```

Il peut configurer le modele + l’authentification pour des fournisseurs courants, y compris **OpenAI Code (Codex)
subscription** (OAuth) et **Anthropic** (cle API recommandee ; `claude
setup-token` egalement pris en charge).

## Cles de configuration (apercu)

- `agents.defaults.model.primary` et `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` et `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (liste d’autorisation + alias + parametres de fournisseur)
- `models.providers` (fournisseurs personnalises ecrits dans `models.json`)

Les references de modele sont normalisees en minuscules. Les alias de fournisseur comme `z.ai/*` sont normalises
en `zai/*`.

Des exemples de configuration de fournisseurs (y compris OpenCode Zen) se trouvent dans
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## « Le modele n’est pas autorise » (et pourquoi les reponses s’arretent)

Si `agents.defaults.models` est defini, il devient la **liste d’autorisation** pour `/model` et pour
les remplacements de session. Lorsqu’un utilisateur selectionne un modele qui n’est pas dans cette liste d’autorisation,
OpenClaw renvoie :

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Cela se produit **avant** qu’une reponse normale ne soit generee ; le message peut donc donner l’impression
qu’« il n’a pas repondu ». La correction consiste soit a :

- Ajouter le modele a `agents.defaults.models`, ou
- Effacer la liste d’autorisation (supprimer `agents.defaults.models`), ou
- Choisir un modele depuis `/model list`.

Exemple de configuration de liste d’autorisation :

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Changer de modele dans le chat (`/model`)

Vous pouvez changer de modele pour la session en cours sans redemarrer :

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Notes :

- `/model` (et `/model list`) est un selecteur compact et numerote (famille de modeles + fournisseurs disponibles).
- `/model <#>` selectionne a partir de ce selecteur.
- `/model status` est la vue detaillee (candidats d’authentification et, lorsqu’ils sont configures, point de terminaison du fournisseur `baseUrl` + mode `api`).
- Les references de modele sont analysees en decoupant sur le **premier** `/`. Utilisez `provider/model` lors de la saisie de `/model <ref>`.
- Si l’ID du modele contient lui‑meme `/` (style OpenRouter), vous devez inclure le prefixe du fournisseur (exemple : `/model openrouter/moonshotai/kimi-k2`).
- Si vous omettez le fournisseur, OpenClaw traite l’entree comme un alias ou un modele pour le **fournisseur par defaut** (fonctionne uniquement lorsqu’il n’y a pas de `/` dans l’ID du modele).

Comportement complet des commandes / configuration : [Commandes slash](/tools/slash-commands).

## Commandes CLI

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (sans sous‑commande) est un raccourci pour `models status`.

### `models list`

Affiche les modeles configures par defaut. Indicateurs utiles :

- `--all` : catalogue complet
- `--local` : fournisseurs locaux uniquement
- `--provider <name>` : filtrer par fournisseur
- `--plain` : un modele par ligne
- `--json` : sortie lisible par machine

### `models status`

Affiche le modele principal resolu, les replis, le modele d’image et un apercu de l’authentification
des fournisseurs configures. Affiche egalement l’etat d’expiration OAuth pour les profils trouves
dans le magasin d’authentification (avertit dans les 24 h par defaut). `--plain` n’imprime que le
modele principal resolu.
L’etat OAuth est toujours affiche (et inclus dans la sortie `--json`). Si un fournisseur configure
n’a pas d’identifiants, `models status` imprime une section **Authentification manquante**.
Le JSON inclut `auth.oauth` (fenetre d’avertissement + profils) et `auth.providers`
(authentification effective par fournisseur).
Utilisez `--check` pour l’automatisation (code de sortie `1` en cas d’absence/expiration, `2` en cas d’expiration imminente).

L’authentification Anthropic preferee est le setup-token de la CLI Claude Code (a executer n’importe ou ; collez‑le sur l’hote de la Gateway (passerelle) si necessaire) :

```bash
claude setup-token
openclaw models status
```

## Scan (modeles gratuits OpenRouter)

`openclaw models scan` inspecte le **catalogue de modeles gratuits** d’OpenRouter et peut
eventuellement sonder les modeles pour la prise en charge des outils et des images.

Drapeaux clés:

- `--no-probe` : ignorer les sondes en direct (metadonnees uniquement)
- `--min-params <b>` : taille minimale des parametres (en milliards)
- `--max-age-days <days>` : ignorer les modeles plus anciens
- `--provider <name>` : filtre de prefixe de fournisseur
- `--max-candidates <n>` : taille de la liste de replis
- `--set-default` : definir `agents.defaults.model.primary` sur la premiere selection
- `--set-image` : definir `agents.defaults.imageModel.primary` sur la premiere selection d’images

La sonde requiert une cle API OpenRouter (depuis les profils d’authentification ou
`OPENROUTER_API_KEY`). Sans cle, utilisez `--no-probe` pour lister uniquement les candidats.

Les resultats du scan sont classes par :

1. Prise en charge des images
2. Latence des outils
3. Taille du contexte
4. Nombre de parametres

Entree

- Liste OpenRouter `/models` (filtre `:free`)
- Necessite une cle API OpenRouter depuis les profils d’authentification ou `OPENROUTER_API_KEY` (voir [/environment](/environment))
- Filtres optionnels : `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Controles de sonde : `--timeout`, `--concurrency`

Lorsqu’il est execute dans un TTY, vous pouvez selectionner les replis de maniere interactive. En mode non interactif,
passez `--yes` pour accepter les valeurs par defaut.

## Registre des modeles (`models.json`)

Les fournisseurs personnalises dans `models.providers` sont ecrits dans `models.json` sous le
repertoire de l’agent (par defaut `~/.openclaw/agents/<agentId>/models.json`). Ce fichier
est fusionne par defaut sauf si `models.mode` est defini sur `replace`.
