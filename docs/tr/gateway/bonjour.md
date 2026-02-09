---
summary: "Bonjour/mDNS keşfi + hata ayıklama (Gateway işaretçileri, istemciler ve yaygın arıza modları)"
read_when:
  - macOS/iOS üzerinde Bonjour keşif sorunlarını giderirken
  - mDNS hizmet türlerini, TXT kayıtlarını veya keşif UX’ini değiştirirken
title: "Bonjour Keşfi"
---

# Bonjour / mDNS keşfi

OpenClaw, etkin bir Gateway’i (WebSocket uç noktası) keşfetmek için **yalnızca LAN’a özel bir kolaylık** olarak Bonjour (mDNS / DNS‑SD) kullanır. En iyi çabayla çalışır ve SSH veya
Tailnet tabanlı bağlantının **yerini almaz**.

## Tailscale üzerinden geniş alan Bonjour (Unicast DNS‑SD)

Düğüm ve gateway farklı ağlardaysa, çok noktaya yayın mDNS sınırı aşmaz. **unicast DNS‑SD** (“Wide‑Area Bonjour”) kullanarak Tailscale üzerinden
aynı keşif UX’ini koruyabilirsiniz.

Üst düzey adımlar:

1. Gateway ana makinesinde bir DNS sunucusu çalıştırın (Tailnet üzerinden erişilebilir).
2. Ayrı bir bölge altında `_openclaw-gw._tcp` için DNS‑SD kayıtları yayımlayın
   (örnek: `openclaw.internal.`).
3. Seçtiğiniz alan adının istemciler (iOS dahil) için bu DNS sunucusu üzerinden
   çözülmesi amacıyla Tailscale **split DNS** yapılandırmasını yapın.

OpenClaw herhangi bir keşif alan adını destekler; `openclaw.internal.` yalnızca bir örnektir.
iOS/Android düğümleri hem `local.` hem de yapılandırdığınız geniş alan alan adını tarar.

### Gateway yapılandırması (önerilir)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Tek seferlik DNS sunucusu kurulumu (gateway ana makinesi)

```bash
openclaw dns setup --apply
```

Bu işlem CoreDNS’i kurar ve şu şekilde yapılandırır:

- yalnızca gateway’in Tailscale arayüzlerinde 53 numaralı portu dinler
- seçtiğiniz alan adını (örnek: `openclaw.internal.`) `~/.openclaw/dns/<domain>.db` üzerinden sunar

Tailnet’e bağlı bir makineden doğrulayın:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS ayarları

Tailscale yönetici konsolunda:

- Gateway’in tailnet IP’sini işaret eden bir ad sunucusu ekleyin (UDP/TCP 53).
- Keşif alan adınızın bu ad sunucusunu kullanması için split DNS ekleyin.

İstemciler tailnet DNS’ini kabul ettikten sonra, iOS düğümleri çok noktaya yayın olmadan
keşif alan adınızda `_openclaw-gw._tcp` tarayabilir.

### Gateway dinleyici güvenliği (önerilir)

Gateway WS portu (varsayılan `18789`) varsayılan olarak loopback’e bağlanır. LAN/tailnet
erişimi için açıkça bağlayın ve kimlik doğrulamayı açık tutun.

Yalnızca tailnet kurulumları için:

- `gateway.bind: "tailnet"` ayarını `~/.openclaw/openclaw.json` içinde yapın.
- Gateway’i yeniden başlatın (veya macOS menü çubuğu uygulamasını yeniden başlatın).

## Neler duyurulur

Yalnızca Gateway, `_openclaw-gw._tcp` duyurusunu yapar.

## Hizmet türleri

- `_openclaw-gw._tcp` — gateway taşıma işaretçisi (macOS/iOS/Android düğümleri tarafından kullanılır).

## TXT anahtarları (gizli olmayan ipuçları)

Gateway, UI akışlarını kolaylaştırmak için küçük ve gizli olmayan ipuçları duyurur:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (yalnızca TLS etkin olduğunda)
- `gatewayTlsSha256=<sha256>` (yalnızca TLS etkin ve parmak izi mevcut olduğunda)
- `canvasPort=<port>` (yalnızca canvas ana makinesi etkin olduğunda; varsayılan `18793`)
- `sshPort=<port>` (üzerine yazılmadığında varsayılan 22)
- `transport=gateway`
- `cliPath=<path>` (isteğe bağlı; çalıştırılabilir bir `openclaw` giriş noktasına mutlak yol)
- `tailnetDns=<magicdns>` (Tailnet mevcut olduğunda isteğe bağlı ipucu)

## Debugging on macOS

Kullanışlı yerleşik araçlar:

- Browse instances:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Bir örneği çözümleyin (`<instance>` ile değiştirin):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Tarama çalışıyor ancak çözümleme başarısız oluyorsa, genellikle bir LAN politikası veya
mDNS çözücü sorununa takılıyorsunuzdur.

## Gateway günlüklerinde hata ayıklama

Gateway, dönen bir günlük dosyası yazar (başlangıçta
`gateway log file: ...` olarak yazdırılır). Özellikle şu `bonjour:` satırlarına bakın:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOS düğümünde hata ayıklama

iOS düğümü, `_openclaw-gw._tcp`’i keşfetmek için `NWBrowser` kullanır.

To capture logs:

- Ayarlar → Gateway → Gelişmiş → **Keşif Hata Ayıklama Günlükleri**
- Ayarlar → Gateway → Gelişmiş → **Keşif Günlükleri** → yeniden üret → **Kopyala**

Günlük, tarayıcı durum geçişlerini ve sonuç kümesi değişikliklerini içerir.

## Yaygın arıza modları

- **Bonjour ağlar arası geçmez**: Tailnet veya SSH kullanın.
- **Çok noktaya yayın engelli**: bazı Wi‑Fi ağları mDNS’i devre dışı bırakır.
- **Uyku / arayüz dalgalanması**: macOS mDNS sonuçlarını geçici olarak düşürebilir; yeniden deneyin.
- **Tarama çalışıyor ama çözümleme başarısız**: makine adlarını basit tutun (emojilerden veya
  noktalama işaretlerinden kaçının), ardından Gateway’i yeniden başlatın. Hizmet örneği adı
  ana makine adından türetilir; aşırı karmaşık adlar bazı çözücüleri şaşırtabilir.

## Escaped instance names (`\032`)

Bonjour/DNS‑SD, hizmet örneği adlarındaki baytları sıklıkla ondalık `\DDD`
dizileri olarak kaçışlar (ör. boşluklar `\032` olur).

- Bu, protokol düzeyinde normaldir.
- UI’lar görüntüleme için çözmelidir (iOS `BonjourEscapes.decode` kullanır).

## Devre dışı bırakma / yapılandırma

- `OPENCLAW_DISABLE_BONJOUR=1` duyurmayı devre dışı bırakır (eski: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind`, `~/.openclaw/openclaw.json` içinde Gateway bağlanma modunu denetler.
- `OPENCLAW_SSH_PORT`, TXT’te duyurulan SSH portunu geçersiz kılar (eski: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS`, TXT’te bir MagicDNS ipucu yayımlar (eski: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH`, duyurulan CLI yolunu geçersiz kılar (eski: `OPENCLAW_CLI_PATH`).

## İlgili dokümanlar

- Keşif politikası ve taşıma seçimi: [Discovery](/gateway/discovery)
- Düğüm eşleştirme + onaylar: [Gateway pairing](/gateway/pairing)
