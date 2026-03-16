---
summary: "Gestion de fuseau horaire pour agents, enveloppes et invites"
read_when:
  - Vous devez comprendre comment les timestamps sont normalisés pour le modèle
  - Configurer le fuseau horaire utilisateur pour les invites système
title: "Fuseaux horaires"
---

# Fuseaux horaires

OpenClaw standardise les timestamps pour que le modèle voie une **heure de référence unique**.

## Enveloppes de message (local par défaut)

Les messages entrants sont enveloppés dans une enveloppe comme :

```
[Provider ... 2026-01-05 16:26 PST] texte de message
```

Le timestamp dans l'enveloppe est **local à l'hôte par défaut**, avec précision en minutes.

Vous pouvez remplacer cela avec :

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | fuseau horaire IANA
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` utilise UTC.
- `envelopeTimezone: "user"` utilise `agents.defaults.userTimezone` (repli vers fuseau horaire hôte).
- Utilisez un fuseau horaire IANA explicite (ex., `"Europe/Vienna"`) pour un décalage fixe.
- `envelopeTimestamp: "off"` retire les timestamps absolus des en-têtes d'enveloppe.
- `envelopeElapsed: "off"` retire les suffixes de temps écoulé (le style `+2m`).

### Exemples

**Local (par défaut) :**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Fuseau horaire fixe :**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Temps écoulé :**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Charges utiles d'outil (données brutes de fournisseur + champs normalisés)

Les appels d'outils (`channels.discord.readMessages`, `channels.slack.readMessages`, etc.) retournent des **timestamps bruts de fournisseur**.
Nous attachons aussi des champs normalisés pour cohérence :

- `timestampMs` (millisecondes d'époque UTC)
- `timestampUtc` (chaîne ISO 8601 UTC)

Les champs bruts de fournisseur sont préservés.

## Fuseau horaire utilisateur pour l'invite système

Définissez `agents.defaults.userTimezone` pour dire au modèle le fuseau horaire local de l'utilisateur. S'il n'est
pas défini, OpenClaw résout le **fuseau horaire hôte à l'exécution** (pas d'écriture de config).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

L'invite système inclut :

- Section `Current Date & Time` avec heure locale et fuseau horaire
- `Time format: 12-hour` ou `24-hour`

Vous pouvez contrôler le format d'invite avec `agents.defaults.timeFormat` (`auto` | `12` | `24`).

Voir [Date et heure](/fr-FR/date-time) pour le comportement complet et des exemples.
