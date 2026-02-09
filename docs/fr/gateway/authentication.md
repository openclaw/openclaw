---
summary: "Authentification des modeles : OAuth, cles API et setup-token"
read_when:
  - Debogage de l’authentification des modeles ou de l’expiration OAuth
  - Documentation de l’authentification ou du stockage des identifiants
title: "Authentification"
---

# Authentification

OpenClaw prend en charge OAuth et les cles API pour les fournisseurs de modeles. Pour les comptes Anthropic, nous recommandons d’utiliser une **cle API**. Pour l’acces par abonnement Claude, utilisez le jeton longue duree cree par `claude setup-token`.

Voir [/concepts/oauth](/concepts/oauth) pour le flux OAuth complet et la structure de stockage.

## Configuration Anthropic recommandee (cle API)

Si vous utilisez Anthropic directement, utilisez une cle API.

1. Creez une cle API dans la console Anthropic.
2. Placez-la sur l’**hote de la Gateway (passerelle)** (la machine executant `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Si la Gateway s’execute sous systemd/launchd, privilegiez le placement de la cle dans
   `~/.openclaw/.env` afin que le demon puisse la lire :

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Redemarrez ensuite le demon (ou redemarrez votre processus Gateway) et verifiez a nouveau :

```bash
openclaw models status
openclaw doctor
```

Si vous preferez ne pas gerer vous-meme les variables d’environnement, l’assistant de prise en main peut stocker les cles API pour une utilisation par le demon : `openclaw onboard`.

Voir [Help](/help) pour les details sur l’heritage des variables d’environnement (`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd).

## Anthropic : setup-token (authentification par abonnement)

Pour Anthropic, la voie recommandee est une **cle API**. Si vous utilisez un abonnement Claude, le flux setup-token est egalement pris en charge. Executez-le sur l’**hote de la Gateway (passerelle)** :

```bash
claude setup-token
```

Puis collez-le dans OpenClaw :

```bash
openclaw models auth setup-token --provider anthropic
```

Si le jeton a ete cree sur une autre machine, collez-le manuellement :

```bash
openclaw models auth paste-token --provider anthropic
```

Si vous voyez une erreur Anthropic telle que :

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…utilisez plutot une cle API Anthropic.

Saisie manuelle du jeton (tout fournisseur ; ecrit `auth-profiles.json` + met a jour la configuration) :

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Verification adaptee a l’automatisation (sortie `1` en cas d’expiration/d’absence, `2` en cas d’expiration imminente) :

```bash
openclaw models status --check
```

Des scripts d’exploitation optionnels (systemd/Termux) sont documentes ici :
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` requiert un TTY interactif.

## Verification de l’etat d’authentification des modeles

```bash
openclaw models status
openclaw doctor
```

## Controle de l’identifiant utilise

### Par session (commande de chat)

Utilisez `/model <alias-or-id>@<profileId>` pour epingler un identifiant de fournisseur specifique pour la session courante (exemples d’identifiants de profil : `anthropic:default`, `anthropic:work`).

Utilisez `/model` (ou `/model list`) pour un selecteur compact ; utilisez `/model status` pour la vue complete (candidats + prochain profil d’authentification, ainsi que les details du point de terminaison du fournisseur lorsqu’ils sont configures).

### Par agent (surcharge CLI)

Definissez une surcharge explicite de l’ordre des profils d’authentification pour un agent (stockee dans le `auth-profiles.json` de cet agent) :

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Utilisez `--agent <id>` pour cibler un agent specifique ; omettez-le pour utiliser l’agent par defaut configure.

## Problemes courants

### « Aucune information d’identification trouvee »

Si le profil de jeton Anthropic est manquant, executez `claude setup-token` sur l’**hote de la Gateway (passerelle)**, puis verifiez a nouveau :

```bash
openclaw models status
```

### Jeton expirant/expire

Executez `openclaw models status` pour confirmer quel profil arrive a expiration. Si le profil est manquant, relancez `claude setup-token` et collez a nouveau le jeton.

## Exigences

- Abonnement Claude Max ou Pro (pour `claude setup-token`)
- Claude Code CLI installee (commande `claude` disponible)
