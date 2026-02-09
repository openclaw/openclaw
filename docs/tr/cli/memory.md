---
summary: "`openclaw memory` için CLI başvurusu (durum/indeks/arama)"
read_when:
  - Anlamsal belleği indekslemek veya aramak istiyorsunuz
  - Bellek kullanılabilirliğini veya indekslemeyi hata ayıklıyorsunuz
title: "bellek"
---

# `openclaw memory`

Anlamsal bellek indeksleme ve aramayı yönetin.
Etkin bellek eklentisi tarafından sağlanır (varsayılan: `memory-core`; devre dışı bırakmak için `plugins.slots.memory = "none"` ayarlayın).

İlgili:

- Bellek kavramı: [Memory](/concepts/memory)
- Eklentiler: [Plugins](/tools/plugin)

## Örnekler

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## Seçenekler

Ortak:

- `--agent <id>`: kapsamı tek bir ajana sınırlar (varsayılan: yapılandırılmış tüm ajanlar).
- `--verbose`: yoklamalar ve indeksleme sırasında ayrıntılı günlükler üretir.

Notlar:

- `memory status --deep` vektör + embedding kullanılabilirliğini yoklar.
- `memory status --deep --index` depo kirliyse yeniden indeksleme çalıştırır.
- `memory index --verbose` aşama başına ayrıntıları yazdırır (sağlayıcı, model, kaynaklar, toplu etkinlik).
- `memory status` `memorySearch.extraPaths` üzerinden yapılandırılmış tüm ek yolları içerir.
