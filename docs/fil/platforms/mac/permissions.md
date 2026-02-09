---
summary: "pagpapatuloy ng mga permiso ng macOS (TCC) at mga kinakailangan sa pag-sign"
read_when:
  - Pag-debug ng nawawala o na-stuck na mga prompt ng permiso ng macOS
  - Pag-package o pag-sign ng macOS app
  - Pagbabago ng mga bundle ID o mga path ng pag-install ng app
title: "Mga Permiso ng macOS"
---

# Mga permiso ng macOS (TCC)

Marupok ang mga macOS permission grant. Iniuugnay ng TCC ang isang permission grant sa
code signature, bundle identifier, at path sa disk ng app. Kung alinman sa mga iyon ay magbago,
itinuturing ng macOS ang app bilang bago at maaaring alisin o itago ang mga prompt.

## Mga kinakailangan para sa matatag na mga permiso

- Parehong path: patakbuhin ang app mula sa isang nakapirming lokasyon (para sa OpenClaw, `dist/OpenClaw.app`).
- Parehong bundle identifier: ang pagbabago ng bundle ID ay lumilikha ng bagong identity ng permiso.
- Naka-sign na app: ang mga unsigned o ad-hoc signed na build ay hindi nagpapatuloy ng mga permiso.
- Pare-parehong signature: gumamit ng tunay na Apple Development o Developer ID certificate
  para manatiling stable ang signature sa mga rebuild.

5. Ang mga ad-hoc signature ay bumubuo ng bagong identity sa bawat build. macOS will forget previous
   grants, and prompts can disappear entirely until the stale entries are cleared.

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

macOS may also gate Desktop, Documents, and Downloads for terminal/background processes. If file reads or directory listings hang, grant access to the same process context that performs file operations (for example Terminal/iTerm, LaunchAgent-launched app, or SSH process).

Workaround: ilipat ang mga file sa OpenClaw workspace (`~/.openclaw/workspace`) kung nais mong iwasan ang per-folder na mga grant.

If you are testing permissions, always sign with a real certificate. Ad-hoc
builds are only acceptable for quick local runs where permissions do not matter.
