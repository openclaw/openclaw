---
summary: "Référence CLI pour `openclaw doctor` (vérifications de santé + réparations guidées)"
read_when:
  - Vous avez des problèmes de connectivité/auth et voulez des correctifs guidés
  - Vous avez mis à jour et voulez une vérification de cohérence
title: "doctor"
---

# `openclaw doctor`

Vérifications de santé + corrections rapides pour la passerelle et les canaux.

Connexe :

- Dépannage : [Dépannage](/fr-FR/gateway/troubleshooting)
- Audit de sécurité : [Sécurité](/fr-FR/gateway/security)

## Exemples

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Notes :

- Les invites interactives (comme les correctifs trousseau/OAuth) ne s'exécutent que quand stdin est un TTY et `--non-interactive` n'est **pas** défini. Les exécutions sans tête (cron, Telegram, pas de terminal) ignoreront les invites.
- `--fix` (alias pour `--repair`) écrit une sauvegarde vers `~/.openclaw/openclaw.json.bak` et supprime les clés de config inconnues, listant chaque suppression.

## macOS : remplacements env `launchctl`

Si vous avez précédemment exécuté `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (ou `...PASSWORD`), cette valeur remplace votre fichier de config et peut causer des erreurs "unauthorized" persistantes.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
