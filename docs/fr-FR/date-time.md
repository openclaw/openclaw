---
summary: "Gestion de la date et de l'heure dans enveloppes, prompts, outils et connecteurs"
read_when:
  - Vous changez comment les horodatages sont affichés au modèle ou aux utilisateurs
  - Vous déboguez le formatage de temps dans messages ou sortie de prompt système
title: "Date et Heure"
---

# Date & Heure

OpenClaw utilise par défaut **l'heure locale de l'hôte pour les horodatages de transport** et **le fuseau horaire utilisateur uniquement dans le prompt système**.
Les horodatages de fournisseur sont préservés pour que les outils gardent leur sémantique native (l'heure actuelle est disponible via `session_status`).

## Enveloppes de message (local par défaut)

Les messages entrants sont enveloppés avec un horodatage (précision minute) :

```
[Fournisseur ... 2026-01-05 16:26 PST] texte du message
```

Cet horodatage d'enveloppe est **local de l'hôte par défaut**, peu importe le fuseau horaire du fournisseur.

Vous pouvez remplacer ce comportement :

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | fuseau IANA
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` utilise UTC.
- `envelopeTimezone: "local"` utilise le fuseau horaire de l'hôte.
- `envelopeTimezone: "user"` utilise `agents.defaults.userTimezone` (repli vers fuseau hôte).
- Utilisez un fuseau IANA explicite (par ex., `"America/Chicago"`) pour une zone fixe.
- `envelopeTimestamp: "off"` supprime les horodatages absolus des en-têtes d'enveloppe.
- `envelopeElapsed: "off"` supprime les suffixes de temps écoulé (style `+2m`).

### Exemples

**Local (par défaut) :**

```
[WhatsApp +1555 2026-01-18 00:19 PST] bonjour
```

**Fuseau horaire utilisateur :**

```
[WhatsApp +1555 2026-01-18 00:19 CST] bonjour
```

**Temps écoulé activé :**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] suite
```

## Prompt système : Date & Heure actuelles

Si le fuseau horaire utilisateur est connu, le prompt système inclut une section dédiée **Date & Heure actuelles** avec **le fuseau horaire uniquement** (pas de format horloge/heure) pour garder la mise en cache de prompt stable :

```
Fuseau horaire : America/Chicago
```

Quand l'agent a besoin de l'heure actuelle, utilisez l'outil `session_status` ; la carte de statut inclut une ligne d'horodatage.

## Lignes d'événement système (local par défaut)

Les événements système en file d'attente insérés dans le contexte de l'agent sont préfixés avec un horodatage utilisant la même sélection de fuseau horaire que les enveloppes de message (par défaut : local de l'hôte).

```
Système : [2026-01-12 12:19:17 PST] Modèle basculé.
```

### Configurer fuseau horaire + format utilisateur

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

- `userTimezone` définit le **fuseau horaire local utilisateur** pour le contexte de prompt.
- `timeFormat` contrôle **l'affichage 12h/24h** dans le prompt. `auto` suit les préfs OS.

## Détection de format d'heure (auto)

Quand `timeFormat: "auto"`, OpenClaw inspecte la préférence OS (macOS/Windows) et se replie sur le formatage de locale. La valeur détectée est **mise en cache par processus** pour éviter les appels système répétés.

## Charges utiles d'outil + connecteurs (temps fournisseur brut + champs normalisés)

Les outils de canal retournent des **horodatages natifs de fournisseur** et ajoutent des champs normalisés pour cohérence :

- `timestampMs` : millisecondes epoch (UTC)
- `timestampUtc` : chaîne UTC ISO 8601

Les champs bruts de fournisseur sont préservés pour ne rien perdre.

- Slack : chaînes epoch-like depuis l'API
- Discord : horodatages ISO UTC
- Telegram/WhatsApp : horodatages numériques/ISO spécifiques au fournisseur

Si vous avez besoin de l'heure locale, convertissez-la en aval en utilisant le fuseau horaire connu.

## Docs liés

- [Prompt Système](/fr-FR/concepts/system-prompt)
- [Fuseaux horaires](/fr-FR/concepts/timezone)
- [Messages](/fr-FR/concepts/messages)
