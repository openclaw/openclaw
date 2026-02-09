---
summary: "Onboarding sihirbazı ve yapılandırma şeması için RPC protokol notları"
read_when: "Onboarding sihirbazı adımlarını veya yapılandırma şeması uç noktalarını değiştirirken"
title: "Onboarding ve Yapılandırma Protokolü"
---

# Onboarding + Yapılandırma Protokolü

Amaç: CLI, macOS uygulaması ve Web UI genelinde paylaşılan onboarding + yapılandırma yüzeyleri.

## Bileşenler

- Sihirbaz motoru (paylaşılan oturum + istemler + onboarding durumu).
- CLI onboarding, UI istemcileriyle aynı sihirbaz akışını kullanır.
- Gateway RPC, sihirbaz + yapılandırma şeması uç noktalarını sunar.
- macOS onboarding, sihirbaz adım modelini kullanır.
- Web UI, JSON Schema + UI ipuçlarından yapılandırma formlarını oluşturur.

## Gateway RPC

- `wizard.start` parametreler: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` parametreler: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` parametreler: `{ sessionId }`
- `wizard.status` parametreler: `{ sessionId }`
- `config.schema` parametreler: `{}`

Yanıtlar (şekil)

- Sihirbaz: `{ sessionId, done, step?, status?, error? }`
- Yapılandırma şeması: `{ schema, uiHints, version, generatedAt }`

## UI İpuçları

- `uiHints` yol anahtarına göre; isteğe bağlı meta veriler (etiket/yardım/grup/sıra/gelişmiş/hassas/yer tutucu).
- Hassas alanlar parola girişi olarak oluşturulur; redaksiyon katmanı yoktur.
- Desteklenmeyen şema düğümleri, ham JSON düzenleyicisine geri düşer.

## Notlar

- Bu doküman, onboarding/yapılandırma için protokol yeniden düzenlemelerini takip etmek için tek yerdir.
