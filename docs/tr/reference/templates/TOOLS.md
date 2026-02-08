---
summary: "TOOLS.md için çalışma alanı şablonu"
read_when:
  - Bir çalışma alanını manuel olarak başlatırken
x-i18n:
  source_path: reference/templates/TOOLS.md
  source_hash: 3ed08cd537620749
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:39Z
---

# TOOLS.md - Yerel Notlar

Skills, araçların _nasıl_ çalıştığını tanımlar. Bu dosya _size_ özgü ayrıntılar içindir — kurulumunuza özgü olanlar.

## Buraya Neler Girer

Örneğin:

- Kamera adları ve konumları
- SSH ana makineleri ve takma adları
- TTS için tercih edilen sesler
- Hoparlör/oda adları
- Cihaz takma adları
- Ortama özgü her şey

## Örnekler

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Neden Ayrı?

Skills paylaşımlıdır. Kurulumunuz size aittir. Ayrı tutmak, notlarınızı kaybetmeden skills’leri güncelleyebilmenizi ve altyapınızı ifşa etmeden skills paylaşabilmenizi sağlar.

---

İşinizi yapmanıza yardımcı olacak her şeyi ekleyin. Bu sizin kısa notlarınız.
