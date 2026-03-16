---
summary: "Comment OpenClaw vendor les identifiants de modèles d'appareils Apple pour les noms conviviaux dans l'application macOS."
read_when:
  - Mise à jour des mappages d'identifiants de modèles d'appareils ou des fichiers NOTICE/licence
  - Modification de l'affichage des noms d'appareils dans l'UI Instances
title: "Base de Données de Modèles d'Appareils"
---

# Base de données de modèles d'appareils (noms conviviaux)

L'application compagnon macOS affiche des noms de modèles d'appareils Apple conviviaux dans l'**UI Instances** en mappant les identifiants de modèles Apple (par ex. `iPad16,6`, `Mac16,6`) vers des noms lisibles par l'humain.

Le mappage est vendoré en JSON sous :

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Source de données

Nous vendorons actuellement le mappage depuis le dépôt sous licence MIT :

- `kyle-seongwoo-jun/apple-device-identifiers`

Pour garder les builds déterministes, les fichiers JSON sont épinglés à des commits upstream spécifiques (enregistrés dans `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Mise à jour de la base de données

1. Choisissez les commits upstream que vous souhaitez épingler (un pour iOS, un pour macOS).
2. Mettez à jour les hashes de commit dans `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Re-téléchargez les fichiers JSON, épinglés à ces commits :

```bash
IOS_COMMIT="<commit sha pour ios-device-identifiers.json>"
MAC_COMMIT="<commit sha pour mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Assurez-vous que `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` correspond toujours à upstream (remplacez-le si la licence upstream change).
5. Vérifiez que l'application macOS build proprement (sans avertissements) :

```bash
swift build --package-path apps/macos
```
