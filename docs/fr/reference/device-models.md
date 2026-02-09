---
summary: "Comment OpenClaw fournit des identifiants de modele d’appareils Apple avec des noms conviviaux dans l’application macOS."
read_when:
  - Mise a jour des correspondances d’identifiants de modele d’appareils ou des fichiers NOTICE/licence
  - Modification de la maniere dont l’interface des Instances affiche les noms des appareils
title: "Base de donnees des modeles d’appareils"
---

# Base de donnees des modeles d’appareils (noms conviviaux)

L’application compagnon macOS affiche des noms conviviaux des modeles d’appareils Apple dans l’interface **Instances** en associant des identifiants de modele Apple (par exemple `iPad16,6`, `Mac16,6`) a des noms lisibles par l’humain.

La correspondance est fournie sous forme de JSON dans :

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Source des donnees

Nous fournissons actuellement la correspondance a partir du depot sous licence MIT :

- `kyle-seongwoo-jun/apple-device-identifiers`

Afin de garantir des builds deterministes, les fichiers JSON sont epingles a des commits amont specifiques (consignes dans `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Mise à jour de la base de données

1. Choisissez les commits amont auxquels vous souhaitez vous epingler (un pour iOS, un pour macOS).
2. Mettez a jour les hachages de commit dans `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Telechargez a nouveau les fichiers JSON, epingles a ces commits :

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Assurez-vous que `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` correspond toujours a l’amont (remplacez-le si la licence amont change).
5. Verifiez que l’application macOS se compile proprement (sans avertissements) :

```bash
swift build --package-path apps/macos
```
