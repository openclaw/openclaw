---
summary: "Gestion de la date et de l’heure à travers les enveloppes, les invites, les outils et les connecteurs"
read_when:
  - Vous modifiez la manière dont les horodatages sont affichés au modele ou aux utilisateurs
  - Vous deboguez la mise en forme de l’heure dans les messages ou la sortie de l’invite systeme
title: "Date et heure"
---

# Date & heure

OpenClaw utilise par defaut **l’heure locale de l’hote pour les horodatages de transport** et **le fuseau horaire de l’utilisateur uniquement dans l’invite systeme**.
Les horodatages du fournisseur sont preserves afin que les outils conservent leurs semantiques natives (l’heure courante est disponible via `session_status`).

## Enveloppes de messages (local par defaut)

Les messages entrants sont encapsules avec un horodatage (precision a la minute) :

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Cet horodatage d’enveloppe est **local a l’hote par defaut**, quel que soit le fuseau horaire du fournisseur.

Vous pouvez remplacer ce comportement :

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

- `envelopeTimezone: "utc"` utilise l’UTC.
- `envelopeTimezone: "local"` utilise le fuseau horaire de l’hote.
- `envelopeTimezone: "user"` utilise `agents.defaults.userTimezone` (revient au fuseau horaire de l’hote).
- Utilisez un fuseau horaire IANA explicite (par ex., `"America/Chicago"`) pour une zone fixe.
- `envelopeTimestamp: "off"` supprime les horodatages absolus des en-tetes d’enveloppe.
- `envelopeElapsed: "off"` supprime les suffixes de temps ecoule (le style `+2m`).

### Exemples

**Local (par defaut) :**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Fuseau horaire de l’utilisateur :**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Temps ecoule active :**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## Invite systeme : Date et heure actuelles

Si le fuseau horaire de l’utilisateur est connu, l’invite systeme inclut une section dediee
**Date et heure actuelles** avec **le fuseau horaire uniquement** (sans horloge/format d’heure)
afin de maintenir la stabilite du cache des invites :

```
Time zone: America/Chicago
```

Lorsque l’agent a besoin de l’heure courante, utilisez l’outil `session_status` ; la
carte d’etat inclut une ligne d’horodatage.

## Lignes d’evenements systeme (local par defaut)

Les evenements systeme en file d’attente inseres dans le contexte de l’agent sont prefixes par un horodatage utilisant la
meme selection de fuseau horaire que les enveloppes de messages (par defaut : local a l’hote).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Configurer le fuseau horaire utilisateur + le format

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` definit le **fuseau horaire local de l’utilisateur** pour le contexte de l’invite.
- `timeFormat` controle l’**affichage 12 h/24 h** dans l’invite. `auto` suit les preferences de l’OS.

## Detection du format de l’heure (auto)

Lorsque `timeFormat: "auto"`, OpenClaw inspecte la preference de l’OS (macOS/Windows)
et revient au formatage par locale. La valeur detectee est **mise en cache par processus**
afin d’eviter des appels systeme repetes.

## Charges utiles des outils + connecteurs (heure brute du fournisseur + champs normalises)

Les outils de canal renvoient des **horodatages natifs du fournisseur** et ajoutent des champs normalises pour la coherence :

- `timestampMs` : millisecondes depuis l’epoch (UTC)
- `timestampUtc` : chaine ISO 8601 en UTC

Les champs bruts du fournisseur sont preserves afin que rien ne soit perdu.

- Slack : chaines de type epoch depuis l’API
- Discord : horodatages ISO en UTC
- Telegram/WhatsApp : horodatages numeriques/ISO specifiques au fournisseur

Si vous avez besoin de l’heure locale, convertissez-la en aval en utilisant le fuseau horaire connu.

## Docs associees

- [Invite systeme](/concepts/system-prompt)
- [Fuseaux horaires](/concepts/timezone)
- [Messages](/concepts/messages)
