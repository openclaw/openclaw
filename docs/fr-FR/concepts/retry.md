---
summary: "Politique de réessai pour les appels de fournisseur sortants"
read_when:
  - Mettre à jour le comportement de réessai de fournisseur ou les valeurs par défaut
  - Déboguer les erreurs d'envoi de fournisseur ou les limites de taux
title: "Politique de réessai"
---

# Politique de réessai

## Objectifs

- Réessayer par requête HTTP, pas par flux multi-étapes.
- Préserver l'ordre en réessayant uniquement l'étape actuelle.
- Éviter de dupliquer les opérations non idempotentes.

## Valeurs par défaut

- Tentatives : 3
- Plafond de délai max : 30000 ms
- Jitter : 0,1 (10 pour cent)
- Valeurs par défaut de fournisseur :
  - Délai min Telegram : 400 ms
  - Délai min Discord : 500 ms

## Comportement

### Discord

- Réessaie uniquement sur les erreurs de limite de taux (HTTP 429).
- Utilise Discord `retry_after` quand disponible, sinon backoff exponentiel.

### Telegram

- Réessaie sur les erreurs transitoires (429, timeout, connect/reset/closed, temporairement indisponible).
- Utilise `retry_after` quand disponible, sinon backoff exponentiel.
- Les erreurs d'analyse Markdown ne sont pas réessayées ; elles replissent vers du texte brut.

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

- Les réessais s'appliquent par requête (envoi de message, téléchargement de média, réaction, sondage, autocollant).
- Les flux composites ne réessaient pas les étapes complétées.
