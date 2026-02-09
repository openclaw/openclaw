---
summary: "Capture de caméra (nœud iOS + app macOS) pour l’utilisation par un agent : photos (jpg) et courtes séquences vidéo (mp4)"
read_when:
  - Ajout ou modification de la capture de caméra sur des nœuds iOS ou macOS
  - Extension des workflows MEDIA en fichiers temporaires accessibles aux agents
title: "Capture de caméra"
---

# Capture de caméra (agent)

OpenClaw prend en charge la **capture de caméra** pour les workflows d’agent :

- **Nœud iOS** (appairé via la Gateway (passerelle)) : capture d’une **photo** (`jpg`) ou d’une **courte séquence vidéo** (`mp4`, avec audio optionnel) via `node.invoke`.
- **Nœud Android** (appairé via la Gateway (passerelle)) : capture d’une **photo** (`jpg`) ou d’une **courte séquence vidéo** (`mp4`, avec audio optionnel) via `node.invoke`.
- **App macOS** (nœud via la Gateway (passerelle)) : capture d’une **photo** (`jpg`) ou d’une **courte séquence vidéo** (`mp4`, avec audio optionnel) via `node.invoke`.

Tout accès à la caméra est contrôlé par des **paramètres définis par l’utilisateur**.

## Nœud iOS

### Paramètre utilisateur (activé par défaut)

- Onglet Réglages iOS → **Caméra** → **Autoriser la caméra** (`camera.enabled`)
  - Par défaut : **activé** (une clé manquante est traitée comme activée).
  - Lorsqu’il est désactivé : les commandes `camera.*` renvoient `CAMERA_DISABLED`.

### Commandes (via la Gateway (passerelle) `node.invoke`)

- `camera.list`
  - Payload de réponse :
    - `devices` : tableau de `{ id, name, position, deviceType }`

- `camera.snap`
  - Parametres :
    - `facing` : `front|back` (par défaut : `front`)
    - `maxWidth` : nombre (optionnel ; par défaut `1600` sur le nœud iOS)
    - `quality` : `0..1` (optionnel ; par défaut `0.9`)
    - `format` : actuellement `jpg`
    - `delayMs` : nombre (optionnel ; par défaut `0`)
    - `deviceId` : chaîne (optionnel ; provenant de `camera.list`)
  - Payload de réponse :
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Garde de payload : les photos sont recompressées afin de maintenir le payload base64 en dessous de 5 Mo.

- `camera.clip`
  - Parametres :
    - `facing` : `front|back` (par défaut : `front`)
    - `durationMs` : nombre (par défaut `3000`, limité à un maximum de `60000`)
    - `includeAudio` : booléen (par défaut `true`)
    - `format` : actuellement `mp4`
    - `deviceId` : chaîne (optionnel ; provenant de `camera.list`)
  - Payload de réponse :
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Pré-requis de premier plan

Comme `canvas.*`, le nœud iOS n’autorise les commandes `camera.*` qu’en **premier plan**. Les invocations en arrière-plan renvoient `NODE_BACKGROUND_UNAVAILABLE`.

### Assistant CLI (fichiers temporaires + MEDIA)

Le moyen le plus simple d’obtenir des pièces jointes consiste à utiliser l’assistant CLI, qui écrit les médias décodés dans un fichier temporaire et affiche `MEDIA:<path>`.

Exemples :

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Remarques :

- `nodes camera snap` utilise par défaut **les deux** orientations afin de fournir à l’agent les deux vues.
- Les fichiers de sortie sont temporaires (dans le répertoire temporaire du système d’exploitation), sauf si vous créez votre propre wrapper.

## Nœud Android

### Paramètre utilisateur (activé par défaut)

- Feuille de réglages Android → **Caméra** → **Autoriser la caméra** (`camera.enabled`)
  - Par défaut : **activé** (une clé manquante est traitée comme activée).
  - Lorsqu’il est désactivé : les commandes `camera.*` renvoient `CAMERA_DISABLED`.

### Autorisations

- Android nécessite des autorisations au moment de l’exécution :
  - `CAMERA` pour `camera.snap` et `camera.clip`.
  - `RECORD_AUDIO` pour `camera.clip` lorsque `includeAudio=true`.

Si des autorisations manquent, l’app demandera l’autorisation lorsque cela est possible ; si elle est refusée, les requêtes `camera.*` échouent avec une erreur `*_PERMISSION_REQUIRED`.

### Exigence d'avant-plan d'Android

Comme `canvas.*`, le nœud Android n’autorise les commandes `camera.*` qu’en **premier plan**. Les invocations en arrière-plan renvoient `NODE_BACKGROUND_UNAVAILABLE`.

### Garde de payload

Les photos sont recompressées afin de maintenir le payload base64 en dessous de 5 Mo.

## App macOS

### Paramètre utilisateur (désactivé par défaut)

L’application compagnon macOS expose une case à cocher :

- **Réglages → Général → Autoriser la caméra** (`openclaw.cameraEnabled`)
  - Par défaut : **désactivé**
  - Lorsqu’il est désactivé : les requêtes de caméra renvoient « Camera disabled by user ».

### Assistant CLI (invocation de nœud)

Utilisez le CLI principal `openclaw` pour invoquer des commandes de caméra sur le nœud macOS.

Exemples :

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

Remarques :

- `openclaw nodes camera snap` utilise par défaut `maxWidth=1600` sauf indication contraire.
- Sur macOS, `camera.snap` attend `delayMs` (par défaut 2000 ms) après la phase de chauffe/stabilisation de l’exposition avant la capture.
- Les payloads de photo sont recompressés afin de maintenir le base64 en dessous de 5 Mo.

## Sécurité et limites pratiques

- L’accès à la caméra et au microphone déclenche les invites d’autorisation habituelles du système d’exploitation (et nécessite des chaînes d’utilisation dans Info.plist).
- Les séquences vidéo sont plafonnées (actuellement `<= 60s`) afin d’éviter des payloads de nœud trop volumineux (surcharge base64 + limites de messages).

## Vidéo d’écran macOS (au niveau du système)

Pour la vidéo d’_écran_ (et non de caméra), utilisez l’application compagnon macOS :

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

Remarques :

- Nécessite l’autorisation macOS **Enregistrement de l’écran** (TCC).
