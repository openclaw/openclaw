---
title: "Référence Configuration"
description: "Référence champ-par-champ complète pour ~/.openclaw/openclaw.json"
---

# Référence Configuration

Chaque champ disponible dans `~/.openclaw/openclaw.json`. Pour aperçu orienté tâches, voir [Configuration](/fr-FR/gateway/configuration).

Format config est **JSON5** (commentaires + trailing commas autorisés). Tous champs optionnels — OpenClaw utilise défauts sûrs quand omis.

---

## Canaux

Chaque canal démarre automatiquement quand sa section config existe (sauf `enabled: false`).

### Accès DM et groupe

Tous canaux supportent politiques DM et politiques groupe :

| Politique DM       | Comportement                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| `pairing` (défaut) | Expéditeurs inconnus obtiennent code pairing one-time ; proprio doit approuver |
| `allowlist`        | Uniquement expéditeurs dans `allowFrom` (ou paired allow store)                |
| `open`             | Autoriser tous DMs entrants (nécessite `allowFrom: ["*"]`)                     |
| `disabled`         | Ignorer tous DMs entrants                                                      |

| Politique Groupe     | Comportement                                                |
| -------------------- | ----------------------------------------------------------- |
| `allowlist` (défaut) | Uniquement groupes correspondant allowlist configurée       |
| `open`               | Bypass allowlists groupe (mention-gating toujours appliqué) |
| `disabled`           | Bloquer tous messages groupe/room                           |

<Note>
`channels.defaults.groupPolicy` définit défaut quand `groupPolicy` provider non défini.
Codes pairing expirent après 1 heure. Requêtes DM pairing pending cappées à **3 par canal**.
</Note>

### WhatsApp

WhatsApp fonctionne via canal web passerelle (Baileys Web). Démarre automatiquement quand session liée existe.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000,
      chunkMode: "length", // length | newline
      mediaMaxMb: 50,
      sendReadReceipts: true,
      groups: {
        "*": { requireMention: true },
      },
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

## Agents

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-sonnet-4",
      workspace: "~/.openclaw/workspace",
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
  },
}
```

Voir [Configuration Complète](/fr-FR/gateway/configuration) pour champs détaillés.

Voir aussi :

- [Configuration](/fr-FR/gateway/configuration)
- [Canaux](/fr-FR/channels/index)
- [Agents](/fr-FR/cli/agents)
