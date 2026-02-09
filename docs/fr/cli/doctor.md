---
summary: "Reference CLI pour `openclaw doctor` (verifications d'etat + reparations guidees)"
read_when:
  - Vous avez des problemes de connectivite/d'authentification et souhaitez des correctifs guides
  - Vous avez effectue une mise a jour et voulez un controle de coherence
title: "doctor"
---

# `openclaw doctor`

Verifications d'etat + correctifs rapides pour la Gateway (passerelle) et les canaux.

En lien :

- Depannage : [Troubleshooting](/gateway/troubleshooting)
- Audit de securite : [Security](/gateway/security)

## Exemples

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Notes :

- Les invites interactives (comme les correctifs du trousseau/OAuth) ne s'executent que lorsque stdin est un TTY et que `--non-interactive` n'est **pas** defini. Les executions sans interface (cron, Telegram, sans terminal) ignorent les invites.
- `--fix` (alias de `--repair`) ecrit une sauvegarde dans `~/.openclaw/openclaw.json.bak` et supprime les cles de configuration inconnues, en listant chaque suppression.

## macOS : remplacements de variables d'environnement `launchctl`

Si vous avez precedemment execute `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (ou `...PASSWORD`), cette valeur remplace votre fichier de configuration et peut provoquer des erreurs persistantes de type « non autorise ».

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
