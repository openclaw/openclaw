---
summary: "Analyse de localisation entrante des canaux (Telegram + WhatsApp) et champs de contexte"
read_when:
  - Ajout ou modification de l'analyse de localisation des canaux
  - Utilisation des champs de contexte de localisation dans les prompts ou outils d'agent
title: "Analyse de Localisation des Canaux"
---

# Analyse de localisation des canaux

OpenClaw normalise les localisations partagées depuis les canaux de chat en :

- texte lisible ajouté au corps du message entrant, et
- champs structurés dans le payload de contexte de réponse automatique.

Actuellement supportés :

- **Telegram** (épingles de localisation + lieux + localisations en direct)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` avec `geo_uri`)

## Formatage du texte

Les localisations sont rendues sous forme de lignes conviviales sans crochets :

- Épingle :
  - `📍 48.858844, 2.294351 ±12m`
- Lieu nommé :
  - `📍 Tour Eiffel — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- Partage en direct :
  - `🛰 Localisation en direct : 48.858844, 2.294351 ±12m`

Si le canal inclut une légende/commentaire, il est ajouté sur la ligne suivante :

```
📍 48.858844, 2.294351 ±12m
Retrouvons-nous ici
```

## Champs de contexte

Lorsqu'une localisation est présente, ces champs sont ajoutés à `ctx` :

- `LocationLat` (nombre)
- `LocationLon` (nombre)
- `LocationAccuracy` (nombre, mètres ; optionnel)
- `LocationName` (chaîne ; optionnel)
- `LocationAddress` (chaîne ; optionnel)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (booléen)

## Notes par canal

- **Telegram** : les lieux correspondent à `LocationName/LocationAddress` ; les localisations en direct utilisent `live_period`.
- **WhatsApp** : `locationMessage.comment` et `liveLocationMessage.caption` sont ajoutés comme ligne de légende.
- **Matrix** : `geo_uri` est analysé comme une localisation épinglée ; l'altitude est ignorée et `LocationIsLive` est toujours false.
