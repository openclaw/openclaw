---
summary: "Köprü protokolü (eski düğümler): TCP JSONL, eşleştirme, kapsamlı RPC"
read_when:
  - Düğüm istemcileri (iOS/Android/macOS düğüm modu) geliştirirken veya hata ayıklarken
  - Eşleştirme veya köprü kimlik doğrulama hatalarını incelerken
  - Gateway tarafından açığa çıkarılan düğüm yüzeyini denetlerken
title: "Köprü Protokolü"
---

# Köprü protokolü (eski düğüm taşıması)

Köprü protokolü **eski** bir düğüm taşımasıdır (TCP JSONL). Yeni düğüm istemcileri
bunun yerine birleşik Gateway WebSocket protokolünü kullanmalıdır.

Bir operatör veya düğüm istemcisi geliştiriyorsanız,
[Gateway protokolü](/gateway/protocol) kullanın.

**Not:** Güncel OpenClaw sürümleri artık TCP köprü dinleyicisini dağıtmamaktadır; bu belge tarihsel referans için tutulmaktadır.
Eski `bridge.*` yapılandırma anahtarları artık yapılandırma şemasının parçası değildir.

## Neden ikisi de var

- **Güvenlik sınırı**: köprü, tam gateway API yüzeyi yerine küçük bir izin listesi açığa çıkarır.
- **Eşleştirme + düğüm kimliği**: düğüm kabulü gateway tarafından yönetilir ve düğüm başına bir belirtece bağlanır.
- **Keşif UX'i**: düğümler LAN üzerinde Bonjour aracılığıyla gateway'leri keşfedebilir veya bir tailnet üzerinden doğrudan bağlanabilir.
- **Loopback WS**: tam WS kontrol düzlemi, SSH ile tünellenmedikçe yerel kalır.

## Taşıma

- TCP, satır başına bir JSON nesnesi (JSONL).
- İsteğe bağlı TLS (`bridge.tls.enabled` true olduğunda).
- Eski varsayılan dinleyici portu `18790` idi (güncel sürümler TCP köprüsü başlatmaz).

TLS etkinleştirildiğinde, keşif TXT kayıtları `bridgeTls=1` ile birlikte
`bridgeTlsSha256` içerir; böylece düğümler sertifikayı sabitleyebilir.

## El sıkışma + eşleştirme

1. İstemci, düğüm meta verileri + belirteç (zaten eşleştirilmişse) ile `hello` gönderir.
2. Eşleştirilmemişse, gateway `error` (`NOT_PAIRED`/`UNAUTHORIZED`) ile yanıtlar.
3. İstemci `pair-request` gönderir.
4. Gateway onayı bekler, ardından `pair-ok` ve `hello-ok` gönderir.

`hello-ok`, `serverName` döndürür ve `canvasHostUrl` içerebilir.

## Çerçeveler

İstemci → Gateway:

- `req` / `res`: kapsamlı gateway RPC (chat, sessions, config, health, voicewake, skills.bins)
- `event`: düğüm sinyalleri (ses dökümü, ajan isteği, sohbet aboneliği, çalıştırma yaşam döngüsü)

Gateway → İstemci:

- `invoke` / `invoke-res`: düğüm komutları (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: abone olunan oturumlar için sohbet güncellemeleri
- `ping` / `pong`: keepalive

Eski izin listesi zorlaması `src/gateway/server-bridge.ts` içinde yer alıyordu (kaldırıldı).

## Exec lifecycle events

Düğümler, system.run etkinliğini yüzeye çıkarmak için `exec.finished` veya `exec.denied` olayları yayımlayabilir.
Bunlar gateway'de sistem olaylarına eşlenir. (Eski düğümler hâlâ `exec.started` yayımlayabilir.)

Yük alanı alanları (belirtilmedikçe tümü isteğe bağlıdır):

- `sessionKey` (zorunlu): sistem olayını alacak ajan oturumu.
- `runId`: gruplama için benzersiz çalıştırma kimliği.
- `command`: ham veya biçimlendirilmiş komut dizesi.
- `exitCode`, `timedOut`, `success`, `output`: tamamlanma ayrıntıları (yalnızca finished).
- `reason`: reddedilme nedeni (yalnızca denied).

## Tailnet kullanımı

- Köprüyü bir tailnet IP'sine bağlayın: `bridge.bind: "tailnet"`,
  `~/.openclaw/openclaw.json` içinde.
- İstemciler MagicDNS adı veya tailnet IP'si üzerinden bağlanır.
- Bonjour ağlar arası **geçmez**; gerektiğinde manuel ana makine/port veya geniş alan DNS‑SD kullanın.

## Versioning

Köprü şu anda **örtük v1**'dir (min/maks müzakere yok). Geriye dönük uyumluluk beklenir; herhangi bir kırıcı değişiklikten önce bir köprü protokolü sürüm alanı ekleyin.
