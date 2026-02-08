---
summary: "Centre de depannage : symptomes → verifications → correctifs"
read_when:
  - Vous voyez une erreur et voulez le chemin de correction
  - L’installateur indique « success » mais la CLI ne fonctionne pas
title: "Depannage"
x-i18n:
  source_path: help/troubleshooting.md
  source_hash: 00ba2a20732fa22c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:01:49Z
---

# Depannage

## Les 60 premieres secondes

Executez ces commandes dans l’ordre :

```bash
openclaw status
openclaw status --all
openclaw gateway probe
openclaw logs --follow
openclaw doctor
```

Si la Gateway (passerelle) est joignable, lancez des sondes approfondies :

```bash
openclaw status --deep
```

## Cas courants de « tout est casse »

### `openclaw: command not found`

Presque toujours un probleme de PATH Node/npm. Commencez ici :

- [Installation (verification du PATH Node/npm)](/install#nodejs--npm-path-sanity)

### L’installateur echoue (ou vous avez besoin des journaux complets)

Relancez l’installateur en mode verbeux pour voir la trace complete et la sortie npm :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Pour les installations beta :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

Vous pouvez aussi definir `OPENCLAW_VERBOSE=1` a la place du drapeau.

### Gateway « unauthorized », impossible de se connecter, ou reconnexions en boucle

- [Depannage de la Gateway](/gateway/troubleshooting)
- [Authentification de la Gateway](/gateway/authentication)

### L’interface Control UI echoue en HTTP (identite de l’appareil requise)

- [Depannage de la Gateway](/gateway/troubleshooting)
- [Control UI](/web/control-ui#insecure-http)

### `docs.openclaw.ai` affiche une erreur SSL (Comcast/Xfinity)

Certaines connexions Comcast/Xfinity bloquent `docs.openclaw.ai` via Xfinity Advanced Security.
Desactivez Advanced Security ou ajoutez `docs.openclaw.ai` a la liste d’autorisation, puis reessayez.

- Aide Xfinity Advanced Security : https://www.xfinity.com/support/articles/using-xfinity-xfi-advanced-security
- Verifications rapides : essayez un point d’acces mobile ou un VPN pour confirmer qu’il s’agit d’un filtrage au niveau du FAI

### Le service indique qu’il est en cours d’execution, mais la sonde RPC echoue

- [Depannage de la Gateway](/gateway/troubleshooting)
- [Processus / service en arriere-plan](/gateway/background-process)

### Echecs de modele/authentification (limite de debit, facturation, « all models failed »)

- [Modeles](/cli/models)
- [Concepts OAuth / auth](/concepts/oauth)

### `/model` indique `model not allowed`

Cela signifie generalement que `agents.defaults.models` est configure comme une liste d’autorisation. Lorsqu’elle n’est pas vide,
seules ces cles fournisseur/modele peuvent etre selectionnees.

- Verifiez la liste d’autorisation : `openclaw config get agents.defaults.models`
- Ajoutez le modele souhaite (ou videz la liste d’autorisation) et relancez `/model`
- Utilisez `/models` pour parcourir les fournisseurs/modeles autorises

### Lors du depot d’un ticket

Collez un rapport sans donnees sensibles :

```bash
openclaw status --all
```

Si possible, incluez la fin des journaux pertinents depuis `openclaw logs --follow`.
