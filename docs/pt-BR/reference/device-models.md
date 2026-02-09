---
summary: "Como o OpenClaw fornece identificadores de modelo de dispositivos Apple para nomes amigáveis no app macOS."
read_when:
  - Atualizando mapeamentos de identificadores de modelo de dispositivos ou arquivos NOTICE/licença
  - Alterando como a UI de Instâncias exibe nomes de dispositivos
title: "Banco de dados de modelos de dispositivos"
---

# Banco de dados de modelos de dispositivos (nomes amigáveis)

O aplicativo complementar para macOS mostra nomes amigáveis de modelos de dispositivos Apple na UI de **Instâncias**, mapeando identificadores de modelo da Apple (por exemplo, `iPad16,6`, `Mac16,6`) para nomes legíveis por humanos.

O mapeamento é fornecido como JSON em:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Fonte de dados

Atualmente, fornecemos o mapeamento a partir do repositório com licença MIT:

- `kyle-seongwoo-jun/apple-device-identifiers`

Para manter builds determinísticos, os arquivos JSON são fixados em commits específicos do upstream (registrados em `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Atualizando o banco de dados

1. Escolha os commits do upstream que você deseja fixar (um para iOS e um para macOS).
2. Atualize os hashes de commit em `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Baixe novamente os arquivos JSON, fixados nesses commits:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Garanta que `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` ainda corresponda ao upstream (substitua-o se a licença do upstream mudar).
5. Verifique se o aplicativo macOS compila corretamente (sem avisos):

```bash
swift build --package-path apps/macos
```
