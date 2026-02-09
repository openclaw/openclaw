---
summary: "Skills yapılandırma şeması ve örnekler"
read_when:
  - Skills yapılandırması eklerken veya değiştirirken
  - Paketli izin listesi veya kurulum davranışını ayarlarken
title: "Skills Yapılandırması"
---

# Skills Yapılandırması

Skills ile ilgili tüm yapılandırmalar `skills` altında, `~/.openclaw/openclaw.json` içinde yer alır.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Alanlar

- `allowBundled`: yalnızca **paketli** Skills için isteğe bağlı izin listesi. Ayarlandığında,
  listede yer alan paketli Skills uygundur (yönetilen/çalışma alanı Skills etkilenmez).
- `load.extraDirs`: taranacak ek skill dizinleri (en düşük öncelik).
- `load.watch`: skill klasörlerini izle ve Skills anlık görüntüsünü yenile (varsayılan: true).
- `load.watchDebounceMs`: skill izleyici olayları için milisaniye cinsinden debounce (varsayılan: 250).
- `install.preferBrew`: mevcut olduğunda brew yükleyicilerini tercih et (varsayılan: true).
- `install.nodeManager`: node yükleyici tercihi (`npm` | `pnpm` | `yarn` | `bun`, varsayılan: npm).
  Bu yalnızca **skill kurulumlarını** etkiler; Gateway çalışma zamanı yine Node olmalıdır
  (WhatsApp/Telegram için Bun önerilmez).
- `entries.<skillKey>`: skill bazında geçersiz kılmalar.

Skill başına alanlar:

- `enabled`: paketli/kurulu olsa bile bir skill’i devre dışı bırakmak için `false` olarak ayarlayın.
- `env`: ajan çalıştırması için enjekte edilen ortam değişkenleri (yalnızca zaten ayarlı değilse).
- `apiKey`: birincil bir ortam değişkeni bildiren Skills için isteğe bağlı kolaylık.

## Notlar

- `entries` altındaki anahtarlar varsayılan olarak skill adına eşlenir. Bir skill
  `metadata.openclaw.skillKey` tanımlıyorsa bunun yerine o anahtarı kullanın.
- İzleyici etkinleştirildiğinde, Skills’teki değişiklikler bir sonraki ajan turunda alınır.

### Sandbox içindeki Skills + ortam değişkenleri

Bir oturum **sandbox** içindeyken, skill süreçleri Docker içinde çalışır. Sandbox,
ana makinenin `process.env` değerini **devralmaz**.

Aşağıdakilerden birini kullanın:

- `agents.defaults.sandbox.docker.env` (veya ajan başına `agents.list[].sandbox.docker.env`)
- 48. ortamı özel sandbox imajınıza gömün

Genel `env` ve `skills.entries.<skill>.env/apiKey` yalnızca **ana makine** çalıştırmaları için geçerlidir.
