---
summary: "Gestion des fuseaux horaires pour les agents, les enveloppes et les invites"
read_when:
  - Vous devez comprendre comment les horodatages sont normalisés pour le modèle
  - Configuration du fuseau horaire de l'utilisateur pour les invites systeme
title: "Fuseaux horaires"
---

# Fuseaux horaires

OpenClaw normalise les horodatages afin que le modele voie une **heure de reference unique**.

## Enveloppes de messages (locales par defaut)

Les messages entrants sont enveloppes comme suit :

```
[Provider ... 2026-01-05 16:26 PST] message text
```

L'horodatage dans l'enveloppe est **local a l'hote par defaut**, avec une precision a la minute.

Vous pouvez remplacer ce comportement avec :

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` utilise l'UTC.
- `envelopeTimezone: "user"` utilise `agents.defaults.userTimezone` (retombe sur le fuseau horaire de l'hote).
- Utilisez un fuseau horaire IANA explicite (par ex., `"Europe/Vienna"`) pour un decalage fixe.
- `envelopeTimestamp: "off"` supprime les horodatages absolus des en-tetes de l'enveloppe.
- `envelopeElapsed: "off"` supprime les suffixes de temps ecoule (le style `+2m`).

### Exemples

**Local (par defaut) :**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Fuseau horaire fixe :**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Temps ecoule :**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Charges utiles des outils (donnees brutes du fournisseur + champs normalises)

Les appels d'outils (`channels.discord.readMessages`, `channels.slack.readMessages`, etc.) renvoient des **horodatages bruts du fournisseur**.
Nous joignons egalement des champs normalises pour plus de coherence :

- `timestampMs` (millisecondes depuis l'epoch UTC)
- `timestampUtc` (chaine UTC ISO 8601)

Les champs bruts du fournisseur sont conserves.

## Fuseau horaire de l'utilisateur pour l'invite systeme

Definissez `agents.defaults.userTimezone` pour indiquer au modele le fuseau horaire local de l'utilisateur. S'il n'est pas
defini, OpenClaw resout le **fuseau horaire de l'hote a l'execution** (sans ecriture de configuration).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

L'invite systeme inclut :

- la section `Current Date & Time` avec l'heure locale et le fuseau horaire
- `Time format: 12-hour` ou `24-hour`

Vous pouvez controler le format de l'invite avec `agents.defaults.timeFormat` (`auto` | `12` | `24`).

Voir [Date & Time](/date-time) pour le comportement complet et des exemples.
