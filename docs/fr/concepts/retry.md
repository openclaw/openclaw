---
summary: "Politique de réessai pour les appels sortants des fournisseurs"
read_when:
  - Mise à jour du comportement ou des valeurs par défaut de réessai des fournisseurs
  - Dépannage des erreurs d’envoi ou des limitations de débit des fournisseurs
title: "Politique de réessai"
---

# Politique de réessai

## Objectifs

- Réessayer par requête HTTP, et non par flux multi‑étapes.
- Préserver l’ordre en ne réessayant que l’étape en cours.
- Éviter la duplication d’opérations non idempotentes.

## Paramètres par défaut

- Tentatives : 3
- Plafond du délai maximal : 30000 ms
- Jitter : 0.1 (10 pour cent)
- Valeurs par défaut du fournisseur :
  - Telegram, délai minimal : 400 ms
  - Discord, délai minimal : 500 ms

## Comportement

### Discord

- Réessaie uniquement en cas d’erreurs de limitation de débit (HTTP 429).
- Utilise Discord `retry_after` lorsque disponible, sinon un backoff exponentiel.

### Telegram

- Réessaie en cas d’erreurs transitoires (429, délai d’attente, connexion/réinitialisation/fermée, temporairement indisponible).
- Utilise `retry_after` lorsque disponible, sinon un backoff exponentiel.
- Les erreurs d’analyse Markdown ne sont pas réessayées ; elles reviennent au texte brut.

## Configuration

Définissez la politique de réessai par fournisseur dans `~/.openclaw/openclaw.json` :

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## Notes

- Les réessais s’appliquent par requête (envoi de message, téléversement de média, réaction, sondage, autocollant).
- Les flux composites ne réessaient pas les étapes déjà terminées.
