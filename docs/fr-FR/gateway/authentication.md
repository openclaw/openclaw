---
summary: "Authentification de modèle : OAuth, clés API et setup-token"
read_when:
  - Débogage de l'auth modèle ou expiration OAuth
  - Documentation de l'authentification ou du stockage des credentials
title: "Authentification"
---

# Authentification

OpenClaw supporte OAuth et les clés API pour les fournisseurs de modèles. Pour les comptes Anthropic, nous recommandons d'utiliser une **clé API**. Pour l'accès par abonnement Claude, utilisez le token de longue durée créé par `claude setup-token`.

Voir [/fr-FR/concepts/oauth](/fr-FR/concepts/oauth) pour le flux OAuth complet et la disposition du stockage.

## Configuration Anthropic recommandée (clé API)

Si vous utilisez Anthropic directement, utilisez une clé API.

1. Créez une clé API dans la Console Anthropic.
2. Placez-la sur **l'hôte passerelle** (la machine exécutant `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Si la Passerelle s'exécute sous systemd/launchd, préférez mettre la clé dans
   `~/.openclaw/.env` pour que le daemon puisse la lire :

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Ensuite redémarrez le daemon (ou redémarrez votre processus Passerelle) et revérifiez :

```bash
openclaw models status
openclaw doctor
```

Si vous préférez ne pas gérer les vars env vous-même, l'assistant d'intégration peut stocker les clés API pour l'usage daemon : `openclaw onboard`.

Voir [Aide](/fr-FR/help) pour les détails sur l'héritage env (`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd).

## Anthropic : setup-token (auth par abonnement)

Pour Anthropic, le chemin recommandé est une **clé API**. Si vous utilisez un abonnement Claude, le flux setup-token est également supporté. Exécutez-le sur **l'hôte passerelle** :

```bash
claude setup-token
```

Ensuite collez-le dans OpenClaw :

```bash
openclaw models auth setup-token --provider anthropic
```

Si le token a été créé sur une autre machine, collez-le manuellement :

```bash
openclaw models auth paste-token --provider anthropic
```

Si vous voyez une erreur Anthropic comme :

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…utilisez une clé API Anthropic à la place.

Entrée de token manuelle (tout fournisseur ; écrit `auth-profiles.json` + met à jour la config) :

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Vérification adaptée à l'automatisation (sort `1` quand expiré/manquant, `2` quand en expiration) :

```bash
openclaw models status --check
```

Des scripts ops optionnels (systemd/Termux) sont documentés ici : [/fr-FR/automation/auth-monitoring](/fr-FR/automation/auth-monitoring)

> `claude setup-token` nécessite un TTY interactif.

## Vérification du statut d'auth modèle

```bash
openclaw models status
openclaw doctor
```

## Contrôler quel credential est utilisé

### Par session (commande de chat)

Utilisez `/model <alias-or-id>@<profileId>` pour épingler un credential de fournisseur spécifique pour la session actuelle (exemples d'ids de profil : `anthropic:default`, `anthropic:work`).

Utilisez `/model` (ou `/model list`) pour un sélecteur compact ; utilisez `/model status` pour la vue complète (candidats + prochain profil auth, plus les détails de point de terminaison fournisseur lorsque configurés).

### Par agent (override CLI)

Définissez un override d'ordre de profil auth explicite pour un agent (stocké dans l'`auth-profiles.json` de cet agent) :

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Utilisez `--agent <id>` pour cibler un agent spécifique ; omettez-le pour utiliser l'agent par défaut configuré.

## Dépannage

### "No credentials found"

Si le profil de token Anthropic est manquant, exécutez `claude setup-token` sur **l'hôte passerelle**, puis revérifiez :

```bash
openclaw models status
```

### Token en expiration/expiré

Exécutez `openclaw models status` pour confirmer quel profil expire. Si le profil est manquant, réexécutez `claude setup-token` et collez le token à nouveau.

## Prérequis

- Abonnement Claude Max ou Pro (pour `claude setup-token`)
- CLI Claude Code installé (commande `claude` disponible)
