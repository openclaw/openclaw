---
summary: "Wake words voix globaux (propriété Passerelle) et comment ils sync à travers nodes"
read_when:
  - Changement comportement wake words voix ou défauts
  - Ajout nouvelles plateformes node nécessitant sync wake word
title: "Voice Wake"
---

# Voice Wake (Wake Words Globaux)

OpenClaw traite **wake words comme liste globale unique** possédée par **Passerelle**.

- Il n'y a **aucun wake word custom per-node**.
- **N'importe quelle UI node/app peut éditer** liste ; changements persistés par Passerelle et broadcastés à tous.
- Chaque device garde toujours son propre toggle **Voice Wake enabled/disabled** (UX local + permissions diffèrent).

## Stockage (host Passerelle)

Wake words stockés sur machine passerelle à :

- `~/.openclaw/settings/voicewake.json`

Forme :

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protocole

### Méthodes

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` avec params `{ triggers: string[] }` → `{ triggers: string[] }`

Notes :

- Triggers normalisés (trimmed, empties droppées). Listes vides fallback vers défauts.
- Limites appliquées pour sécurité (caps count/length).

### Événements

- `voicewake.changed` payload `{ triggers: string[] }`

Qui le reçoit :

- Tous clients WebSocket (app macOS, WebChat, etc.)
- Tous nodes connectés (iOS/Android), et aussi sur node connect comme push "état actuel" initial.

## Comportement client

### App macOS

- Utilise liste globale pour gate triggers `VoiceWakeRuntime`.
- Édition "Trigger words" dans settings Voice Wake appelle `voicewake.set` puis repose sur broadcast pour garder autres clients sync.

### Node iOS

- Utilise liste globale pour détection trigger `VoiceWakeManager`.
- Édition Wake Words dans Settings appelle `voicewake.set` (via Gateway WS) et garde aussi détection wake-word locale responsive.

### Node Android

- Expose éditeur Wake Words dans Settings.
- Appelle `voicewake.set` via Gateway WS donc édits sync partout.

## Wake words défaut

Défauts quand liste vide ou manquante :

```json
["openclaw", "claude", "computer"]
```

## Limites

- **Max triggers** : 10
- **Max longueur per trigger** : 50 caractères
- **Min longueur per trigger** : 2 caractères

Violations produisent erreur validation ; liste garde valeurs précédentes.

## Exemple flow édition

1. User ouvre Settings Voice Wake dans app iOS
2. Modifie triggers vers `["hey claude", "openclaw"]`
3. App iOS appelle `voicewake.set({ triggers: ["hey claude", "openclaw"] })`
4. Passerelle persiste vers `voicewake.json`
5. Passerelle broadcast événement `voicewake.changed` vers tous clients
6. App macOS, autres nodes iOS/Android, WebChat reçoivent update
7. Tous clients commencent utiliser nouveaux triggers

## Dépannage

Si wake words ne sync pas :

```bash
# Vérifier état actuel
openclaw config get voicewake

# Logs verbose
openclaw logs --follow --grep voicewake

# Reset vers défauts
rm ~/.openclaw/settings/voicewake.json
```

Redémarrez passerelle après reset manuel.

Voir aussi :

- [Voice Wake macOS](/fr-FR/platforms/mac/voicewake)
- [Nodes](/fr-FR/nodes/index)
- [Configuration](/fr-FR/gateway/configuration)
