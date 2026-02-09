---
summary: "Gateway’i bulmak için düğüm keşfi ve taşıma yöntemleri (Bonjour, Tailscale, SSH)"
read_when:
  - Bonjour keşfi/yayınını uygularken veya değiştirirken
  - Uzak bağlantı modlarını ayarlarken (doğrudan vs SSH)
  - Uzak düğümler için düğüm keşfi + eşleştirme tasarlarken
title: "Keşif ve Taşıma Yöntemleri"
---

# Keşif ve taşıma yöntemleri

OpenClaw yüzeyde benzer görünen iki ayrı probleme sahiptir:

1. **Operatör uzaktan kontrolü**: başka bir yerde çalışan bir gateway’i kontrol eden macOS menü çubuğu uygulaması.
2. **Düğüm eşleştirme**: iOS/Android (ve gelecekteki düğümler) için bir gateway’i bulma ve güvenli şekilde eşleştirme.

Tasarım hedefi, tüm ağ keşfi/yayınını **Node Gateway**’de (`openclaw gateway`) tutmak ve istemcileri (mac uygulaması, iOS) yalnızca tüketici olarak konumlandırmaktır.

## Terms

- **Gateway**: durumu (oturumlar, eşleştirme, düğüm kaydı) yöneten ve kanalları çalıştıran, uzun süre çalışan tek bir gateway süreci. Çoğu kurulumda ana makine başına bir tane kullanılır; yalıtılmış çoklu gateway kurulumları mümkündür.
- **Gateway WS (kontrol düzlemi)**: varsayılan olarak `127.0.0.1:18789` üzerindeki WebSocket uç noktası; `gateway.bind` aracılığıyla LAN/tailnet’e bağlanabilir.
- **Doğrudan WS taşıması**: LAN/tailnet’e bakan Gateway WS uç noktası (SSH yok).
- **SSH taşıması (yedek)**: `127.0.0.1:18789`’ün SSH üzerinden iletilmesiyle uzaktan kontrol.
- **Eski TCP köprüsü (kullanımdan kaldırıldı/kaldırıldı)**: daha eski düğüm taşıması (bkz. [Köprü protokolü](/gateway/bridge-protocol)); artık keşif için duyurulmaz.

Protokol ayrıntıları:

- [Gateway protokolü](/gateway/protocol)
- [Köprü protokolü (eski)](/gateway/bridge-protocol)

## Neden hem “doğrudan” hem de SSH’i koruyoruz

- **Doğrudan WS**, aynı ağda ve bir tailnet içinde en iyi kullanıcı deneyimini sunar:
  - Bonjour ile LAN üzerinde otomatik keşif
  - gateway’e ait eşleştirme belirteçleri + ACL’ler
  - kabuk erişimi gerekmez; protokol yüzeyi dar ve denetlenebilir kalır
- **SSH**, evrensel yedek olarak kalır:
  - SSH erişiminiz olan her yerde çalışır (ilişkisiz ağlar arasında bile)
  - multicast/mDNS sorunlarından etkilenmez
  - SSH dışında yeni bir gelen port gerektirmez

## Keşif girdileri (istemciler gateway’in nerede olduğunu nasıl öğrenir)

### 1. Bonjour / mDNS (yalnızca LAN)

Bonjour en iyi çaba esaslıdır ve ağlar arasında çalışmaz. Yalnızca “aynı LAN” kolaylığı için kullanılır.

Hedef yaklaşım:

- **Gateway**, WS uç noktasını Bonjour üzerinden duyurur.
- İstemciler tarar ve bir “gateway seç” listesi gösterir, ardından seçilen uç noktayı kaydeder.

Sorun giderme ve beacon ayrıntıları: [Bonjour](/gateway/bonjour).

#### Servis beacon ayrıntıları

- Servis türleri:
  - `_openclaw-gw._tcp` (gateway taşıma beacon’ı)
- TXT anahtarları (gizli olmayan):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (veya duyurulan her neyse)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (yalnızca TLS etkin olduğunda)
  - `gatewayTlsSha256=<sha256>` (yalnızca TLS etkin ve parmak izi mevcut olduğunda)
  - `canvasPort=18793` (varsayılan canvas ana makine portu; `/__openclaw__/canvas/`’yi sunar)
  - `cliPath=<path>` (isteğe bağlı; çalıştırılabilir bir `openclaw` giriş noktası veya ikili dosyanın mutlak yolu)
  - `tailnetDns=<magicdns>` (isteğe bağlı ipucu; Tailscale mevcutsa otomatik algılanır)

Devre dışı bırakma/geçersiz kılma:

- `OPENCLAW_DISABLE_BONJOUR=1` yayını devre dışı bırakır.
- `gateway.bind`, `~/.openclaw/openclaw.json` içinde Gateway bağlama modunu kontrol eder.
- `OPENCLAW_SSH_PORT`, TXT’te duyurulan SSH portunu geçersiz kılar (varsayılan 22).
- `OPENCLAW_TAILNET_DNS`, bir `tailnetDns` ipucu (MagicDNS) yayımlar.
- `OPENCLAW_CLI_PATH`, duyurulan CLI yolunu geçersiz kılar.

### 2. Tailnet (ağlar arası)

Londra/Viyana tarzı kurulumlarda Bonjour yardımcı olmaz. Önerilen “doğrudan” hedef:

- Tailscale MagicDNS adı (tercih edilir) veya sabit bir tailnet IP’si.

Gateway, Tailscale altında çalıştığını algılayabilirse, istemciler için (geniş alan beacon’ları dâhil) isteğe bağlı bir ipucu olarak `tailnetDns`’ü yayımlar.

### 3. Manuel / SSH hedefi

Doğrudan bir rota yoksa (veya doğrudan devre dışıysa), istemciler her zaman loopback gateway portunu ileterek SSH üzerinden bağlanabilir.

[Uzak erişim](/gateway/remote).

## Taşıma seçimi (istemci politikası)

Önerilen istemci davranışı:

1. Eşleştirilmiş bir doğrudan uç nokta yapılandırılmış ve erişilebilir ise, onu kullan.
2. Aksi halde, Bonjour LAN üzerinde bir gateway bulursa, tek dokunuşla “Bu gateway’i kullan” seçeneğini sun ve doğrudan uç nokta olarak kaydet.
3. Aksi halde, bir tailnet DNS/IP yapılandırılmışsa, doğrudan dene.
4. Aksi halde, SSH’e geri dön.

## Eşleştirme + kimlik doğrulama (doğrudan taşıma)

Gateway, düğüm/istemci kabulü için tek doğruluk kaynağıdır.

- Eşleştirme istekleri gateway’de oluşturulur/onaylanır/reddedilir (bkz. [Gateway eşleştirme](/gateway/pairing)).
- Gateway şunları uygular:
  - kimlik doğrulama (belirteç / anahtar çifti)
  - kapsamlar/ACL’ler (gateway her yönteme ham bir proxy değildir)
  - hız sınırları

## Bileşenlere göre sorumluluklar

- **Gateway**: keşif beacon’larını duyurur, eşleştirme kararlarını sahiplenir ve WS uç noktasını barındırır.
- **macOS uygulaması**: bir gateway seçmenize yardımcı olur, eşleştirme istemlerini gösterir ve yalnızca yedek olarak SSH kullanır.
- **iOS/Android düğümleri**: kolaylık olarak Bonjour’u tarar ve eşleştirilmiş Gateway WS’ye bağlanır.
