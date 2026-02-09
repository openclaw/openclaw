---
summary: "`openclaw onboard` için CLI başvuru belgesi (etkileşimli katılım sihirbazı)"
read_when:
  - gateway, çalışma alanı, kimlik doğrulama, kanallar ve Skills için rehberli kurulum istediğinizde
title: "onboard"
---

# `openclaw onboard`

Etkileşimli katılım sihirbazı (yerel veya uzak Gateway kurulumu).

## İlgili kılavuzlar

- CLI katılım merkezi: [Katılım Sihirbazı (CLI)](/start/wizard)
- CLI katılım başvurusu: [CLI Katılım Başvurusu](/start/wizard-cli-reference)
- CLI otomasyonu: [CLI Otomasyonu](/start/wizard-cli-automation)
- macOS katılımı: [Katılım (macOS Uygulaması)](/start/onboarding)

## Örnekler

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Akış notları:

- `quickstart`: minimum istemler, bir gateway belirteci otomatik oluşturulur.
- `manual`: bağlantı noktası/bağlama/kimlik doğrulama için tam istemler (`advanced` takma adı).
- En hızlı ilk sohbet: `openclaw dashboard` (Kontrol Arayüzü, kanal kurulumu yok).

## Yaygın takip komutları

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` etkileşimsiz modu ifade etmez. Betikler için `--non-interactive` kullanın.
</Note>
