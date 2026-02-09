---
summary: "WebSocket gateway mimarisi, bileşenler ve istemci akışları"
read_when:
  - Gateway protokolü, istemciler veya taşıma katmanları üzerinde çalışırken
title: "Gateway Mimarisi"
---

# Gateway mimarisi

Son güncelleme: 2026-01-22

## Genel bakış

- Tek ve uzun ömürlü bir **Gateway**, tüm mesajlaşma yüzeylerinin sahibidir (Baileys üzerinden WhatsApp,
  grammY üzerinden Telegram, Slack, Discord, Signal, iMessage, WebChat).
- Kontrol düzlemi istemcileri (macOS uygulaması, CLI, web UI, otomasyonlar),
  yapılandırılmış bağlama ana makinesinde (varsayılan
  `127.0.0.1:18789`) **WebSocket** üzerinden Gateway’e bağlanır.
- **Node**’lar (macOS/iOS/Android/headless) da **WebSocket** üzerinden bağlanır, ancak
  açık yetenekler/komutlar ile `role: node` bildirir.
- Ana makine başına bir Gateway; WhatsApp oturumunu açan tek yerdir.
- Bir **canvas ana makinesi** (varsayılan `18793`), ajan tarafından düzenlenebilir HTML ve A2UI sunar.

## Bileşenler ve akışlar

### Gateway (daemon)

- Sağlayıcı bağlantılarını sürdürür.
- Tipli bir WS API’si sunar (istekler, yanıtlar, sunucu-itmeli olaylar).
- Gelen çerçeveleri JSON Schema’ya göre doğrular.
- `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron` gibi olaylar yayar.

### İstemciler (mac uygulaması / CLI / web yönetimi)

- İstemci başına bir WS bağlantısı.
- İstekler gönderir (`health`, `status`, `send`, `agent`, `system-presence`).
- Olaylara abone olur (`tick`, `agent`, `presence`, `shutdown`).

### Node’lar (macOS / iOS / Android / headless)

- `role: node` ile **aynı WS sunucusuna** bağlanır.
- `connect` içinde bir cihaz kimliği sağlar; eşleştirme **cihaz tabanlıdır** (rol `node`) ve
  onay cihaz eşleştirme deposunda tutulur.
- `canvas.*`, `camera.*`, `screen.record`, `location.get` gibi komutları sunar.

Protokol ayrıntıları:

- [Gateway protokolü](/gateway/protocol)

### WebChat

- Sohbet geçmişi ve gönderimler için Gateway WS API’sini kullanan statik bir UI.
- Uzak kurulumlarda, diğer istemcilerle aynı SSH/Tailscale tüneli üzerinden bağlanır.

## Bağlantı yaşam döngüsü (tek istemci)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## Wire protokolü (özet)

- Taşıma: WebSocket, JSON yükleri içeren metin çerçeveleri.
- İlk çerçeve **zorunlu olarak** `connect` olmalıdır.
- El sıkışmadan sonra:
  - İstekler: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Olaylar: `{type:"event", event, payload, seq?, stateVersion?}`
- `OPENCLAW_GATEWAY_TOKEN` (veya `--token`) ayarlanmışsa, `connect.params.auth.token`
  eşleşmelidir; aksi halde soket kapanır.
- Yan etki oluşturan yöntemler (`send`, `agent`) için güvenli yeniden deneme amacıyla
  idempotency anahtarları zorunludur; sunucu kısa ömürlü bir tekilleştirme önbelleği tutar.
- Node’lar `role: "node"` ile birlikte yetenekler/komutlar/izinleri `connect` içinde göndermelidir.

## Eşleştirme + yerel güven

- Tüm WS istemcileri (operatörler + node’lar) `connect` üzerinde bir **cihaz kimliği** içerir.
- Yeni cihaz kimlikleri eşleştirme onayı gerektirir; Gateway, sonraki bağlantılar için bir **cihaz belirteci**
  verir.
- **Yerel** bağlantılar (loopback veya gateway ana makinesinin kendi tailnet adresi)
  aynı ana makinede UX’i akıcı tutmak için otomatik onaylanabilir.
- **Yerel olmayan** bağlantılar `connect.challenge` nonce’unu imzalamalıdır ve
  açık onay gerektirir.
- Gateway kimlik doğrulaması (`gateway.auth.*`) yerel veya uzak **tüm** bağlantılar için
  geçerlidir.

Ayrıntılar: [Gateway protokolü](/gateway/protocol), [Eşleştirme](/channels/pairing),
[Güvenlik](/gateway/security).

## Protokol tiplemesi ve kod üretimi

- TypeBox şemaları protokolü tanımlar.
- JSON Schema bu şemalardan üretilir.
- Swift modelleri JSON Schema’dan üretilir.

## Uzak erişim

- Tercih edilen: Tailscale veya VPN.

- Alternatif: SSH tüneli

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Tünel üzerinden de aynı el sıkışma + kimlik doğrulama belirteci uygulanır.

- Uzak kurulumlarda WS için TLS + isteğe bağlı pinning etkinleştirilebilir.

## Operasyonlar özeti

- Başlatma: `openclaw gateway` (ön planda, günlükler stdout’a).
- Sağlık: WS üzerinden `health` (ayrıca `hello-ok` içinde yer alır).
- Gözetim: otomatik yeniden başlatma için launchd/systemd.

## Invariants

- Her ana makinede tek bir Gateway, tek bir Baileys oturumunu kontrol eder.
- El sıkışma zorunludur; JSON olmayan veya ilk çerçevesi connect olmayan her şey sert kapatma ile sonuçlanır.
- Olaylar tekrar oynatılmaz; boşluklarda istemciler yenileme yapmalıdır.
