---
summary: "pagpapatuloy ng mga permiso ng macOS (TCC) at mga kinakailangan sa pag-sign"
read_when:
  - Pag-debug ng nawawala o na-stuck na mga prompt ng permiso ng macOS
  - Pag-package o pag-sign ng macOS app
  - Pagbabago ng mga bundle ID o mga path ng pag-install ng app
title: "Mga Permiso ng macOS"
x-i18n:
  source_path: platforms/mac/permissions.md
  source_hash: 52bee5c896e31e99
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:42Z
---

# Mga permiso ng macOS (TCC)

Marupok ang mga grant ng permiso sa macOS. Iniuugnay ng TCC ang isang grant ng permiso sa
code signature ng app, bundle identifier, at path sa disk. Kapag may nagbago sa alinman,
itinuturing ng macOS na bago ang app at maaaring alisin o itago ang mga prompt.

## Mga kinakailangan para sa matatag na mga permiso

- Parehong path: patakbuhin ang app mula sa isang nakapirming lokasyon (para sa OpenClaw, `dist/OpenClaw.app`).
- Parehong bundle identifier: ang pagbabago ng bundle ID ay lumilikha ng bagong identity ng permiso.
- Naka-sign na app: ang mga unsigned o ad-hoc signed na build ay hindi nagpapatuloy ng mga permiso.
- Pare-parehong signature: gumamit ng tunay na Apple Development o Developer ID certificate
  para manatiling stable ang signature sa mga rebuild.

Ang mga ad-hoc signature ay bumubuo ng bagong identity sa bawat build. Makakalimutan ng macOS ang mga naunang grant, at maaaring tuluyang mawala ang mga prompt hanggang malinisan ang mga stale na entry.

## Checklist sa pag-recover kapag nawawala ang mga prompt

1. Isara ang app.
2. Alisin ang entry ng app sa System Settings -> Privacy & Security.
3. Ilunsad muli ang app mula sa parehong path at muling i-grant ang mga permiso.
4. Kung hindi pa rin lumalabas ang prompt, i-reset ang mga TCC entry gamit ang `tccutil` at subukan muli.
5. Ang ilang permiso ay muling lalabas lamang pagkatapos ng buong restart ng macOS.

Mga halimbawang reset (palitan ang bundle ID kung kinakailangan):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Mga permiso sa Files at Folders (Desktop/Documents/Downloads)

Maaari ring higpitan ng macOS ang Desktop, Documents, at Downloads para sa mga terminal/background na proseso. Kung nagha-hang ang pagbabasa ng file o paglista ng directory, i-grant ang access sa parehong process context na nagsasagawa ng mga operasyon sa file (halimbawa Terminal/iTerm, app na inilunsad ng LaunchAgent, o SSH process).

Workaround: ilipat ang mga file sa OpenClaw workspace (`~/.openclaw/workspace`) kung nais mong iwasan ang per-folder na mga grant.

Kung nagte-test ka ng mga permiso, palaging mag-sign gamit ang tunay na certificate. Ang mga ad-hoc
na build ay katanggap-tanggap lamang para sa mabilis na lokal na pagtakbo kung saan hindi mahalaga ang mga permiso.
