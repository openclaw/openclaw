---
summary: "Analyse des emplacements entrants des canaux (Telegram + WhatsApp) et champs de contexte"
read_when:
  - Ajout ou modification de l’analyse des emplacements de canal
  - Utilisation des champs de contexte d’emplacement dans les invites ou outils d’agent
title: "Analyse des emplacements de canal"
---

# Analyse des emplacements de canal

OpenClaw normalise les emplacements partagés depuis les canaux de discussion en :

- du texte lisible par l’humain ajouté au corps entrant, et
- des champs structurés dans la charge utile de contexte de réponse automatique.

Actuellement pris en charge :

- **Telegram** (épingles d’emplacement + lieux + emplacements en direct)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` avec `geo_uri`)

## Mise en forme du texte

Les emplacements sont rendus sous forme de lignes conviviales sans crochets :

- Épingle :
  - `📍 48.858844, 2.294351 ±12m`
- Lieu nommé :
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- Partage en direct :
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

Si le canal inclut une légende/un commentaire, il est ajouté à la ligne suivante :

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## Champs de contexte

Lorsqu’un emplacement est présent, ces champs sont ajoutés à `ctx` :

- `LocationLat` (nombre)
- `LocationLon` (nombre)
- `LocationAccuracy` (nombre, mètres ; facultatif)
- `LocationName` (chaîne ; facultatif)
- `LocationAddress` (chaîne ; facultatif)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (booléen)

## Notes par canal

- **Telegram** : les lieux correspondent à `LocationName/LocationAddress` ; les emplacements en direct utilisent `live_period`.
- **WhatsApp** : `locationMessage.comment` et `liveLocationMessage.caption` sont ajoutés comme ligne de légende.
- **Matrix** : `geo_uri` est analysé comme une épingle d’emplacement ; l’altitude est ignorée et `LocationIsLive` est toujours faux.
