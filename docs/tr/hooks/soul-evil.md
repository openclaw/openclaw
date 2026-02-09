---
summary: "SOUL Evil hook'u (SOUL.md dosyasını SOUL_EVIL.md ile değiştirir)"
read_when:
  - SOUL Evil hook'unu etkinleştirmek veya ayarlamak istiyorsanız
  - Bir purge penceresi veya rastgele olasılıkla persona değişimi istiyorsanız
title: "SOUL Evil Hook"
---

# SOUL Evil Hook

SOUL Evil hook, bir purge penceresi sırasında veya rastgele bir olasılıkla **enjekte edilen** `SOUL.md` içeriğini `SOUL_EVIL.md` ile değiştirir. Disk üzerindeki dosyaları **değiştirmez**.

## Nasıl Çalışır

`agent:bootstrap` çalıştığında, hook sistem prompt'u oluşturulmadan önce bellekteki `SOUL.md` içeriğini değiştirebilir. Eğer `SOUL_EVIL.md` eksik veya boşsa, OpenClaw bir uyarı günlüğe kaydeder ve normal `SOUL.md` korunur.

Alt ajan çalıştırmaları, önyükleme dosyalarında `SOUL.md` içermez; bu nedenle bu hook alt ajanlar üzerinde etkili değildir.

## Etkinleştirme

```bash
openclaw hooks enable soul-evil
```

Ardından yapılandırmayı ayarlayın:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

Ajan çalışma alanı kökünde (`SOUL.md` dosyasının yanında) `SOUL_EVIL.md` oluşturun.

## Seçenekler

- `file` (string): alternatif SOUL dosya adı (varsayılan: `SOUL_EVIL.md`)
- `chance` (0–1 sayı): her çalıştırmada `SOUL_EVIL.md` kullanılma rastgele olasılığı
- `purge.at` (HH:mm): günlük purge başlangıcı (24 saatlik saat)
- `purge.duration` (süre): pencere uzunluğu (örn. `30s`, `10m`, `1h`)

**Öncelik:** purge penceresi, olasılığa göre önceliklidir.

**Saat dilimi:** ayarlandığında `agents.defaults.userTimezone` kullanılır; aksi halde ana makinenin saat dilimi kullanılır.

## Notlar

- Disk üzerinde hiçbir dosya yazılmaz veya değiştirilmez.
- Eğer `SOUL.md` önyükleme listesinde yoksa, hook hiçbir şey yapmaz.

## Ayrıca Bakınız

- [Hooks](/automation/hooks)
