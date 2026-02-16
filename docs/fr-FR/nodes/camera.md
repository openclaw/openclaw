---
summary: "Capture caméra (nœud iOS + app macOS) pour usage agent : photos (jpg) et clips vidéo courts (mp4)"
read_when:
  - Ajout ou modification capture caméra sur nœuds iOS ou macOS
  - Extension workflows fichiers temp MEDIA accessibles agent
title: "Capture Caméra"
---

# Capture Caméra (agent)

OpenClaw supporte **capture caméra** pour workflows agent :

- **Nœud iOS** (appairé via Passerelle) : capturer **photo** (`jpg`) ou **clip vidéo court** (`mp4`, avec audio optionnel) via `node.invoke`.
- **Nœud Android** (appairé via Passerelle) : capturer **photo** (`jpg`) ou **clip vidéo court** (`mp4`, avec audio optionnel) via `node.invoke`.
- **App macOS** (nœud via Passerelle) : capturer **photo** (`jpg`) ou **clip vidéo court** (`mp4`, avec audio optionnel) via `node.invoke`.

Tout accès caméra est gardé derrière **paramètres contrôlés utilisateur**.

## Nœud iOS

### Paramètre utilisateur (défaut activé)

- Onglet Réglages iOS → **Camera** → **Allow Camera** (`camera.enabled`)
  - Défaut : **activé** (clé manquante traitée comme activé).
  - Quand désactivé : commandes `camera.*` retournent `CAMERA_DISABLED`.

### Commandes (via Gateway `node.invoke`)

- `camera.list`
  - Payload réponse :
    - `devices` : array de `{ id, name, position, deviceType }`

- `camera.snap`
  - Params :
    - `facing` : `front|back` (défaut : `front`)
    - `maxWidth` : number (optionnel ; défaut `1600` sur nœud iOS)
    - `quality` : `0..1` (optionnel ; défaut `0.9`)
    - `format` : actuellement `jpg`
    - `delayMs` : number (optionnel ; défaut `0`)
    - `deviceId` : string (optionnel ; depuis `camera.list`)
  - Payload réponse :
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Guard payload : photos sont recompressées pour garder payload base64 sous 5 MB.

- `camera.clip`
  - Params :
    - `facing` : `front|back` (défaut : `front`)
    - `durationMs` : number (défaut `3000`, clampé à max `60000`)
    - `includeAudio` : boolean (défaut `true`)
    - `format` : actuellement `mp4`
    - `deviceId` : string (optionnel ; depuis `camera.list`)
  - Payload réponse :
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Exigence Foreground

Les captures caméra nécessitent que l'app soit en foreground.

Voir aussi :

- [Nœuds](/fr-FR/nodes/index)
- [App iOS](/fr-FR/platforms/ios)
- [App macOS](/fr-FR/platforms/macos)
