---
summary: "OpenClaw presence kayıtlarının nasıl üretildiği, birleştirildiği ve görüntülendiği"
read_when:
  - Debugging the Instances tab
  - Yinelenen veya bayat instance satırlarını araştırma
  - Gateway WS bağlantısını veya sistem-olayı beacon'larını değiştirme
title: "Presence"
---

# Presence

OpenClaw “presence”, aşağıdakilerin hafif ve en iyi çaba esaslı bir görünümüdür:

- **Gateway**’in kendisi ve
- **Gateway’e bağlı istemciler** (mac uygulaması, WebChat, CLI vb.)

Presence, öncelikle macOS uygulamasındaki **Instances** sekmesini oluşturmak ve
operatörlere hızlı görünürlük sağlamak için kullanılır.

## Presence alanları (görünenler)

Presence girdileri, aşağıdaki gibi alanlara sahip yapılandırılmış nesnelerdir:

- `instanceId` (isteğe bağlı ancak güçlü biçimde önerilir): kararlı istemci kimliği (genellikle `connect.client.instanceId`)
- `host`: insan tarafından okunabilir ana makine adı
- `ip`: en iyi çaba esaslı IP adresi
- `version`: istemci sürüm dizesi
- `deviceFamily` / `modelIdentifier`: donanım ipuçları
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: “son kullanıcı girdisinden bu yana geçen saniye” (biliniyorsa)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: son güncelleme zaman damgası (epoch’tan beri ms)

## Üreticiler (presence nereden gelir)

Presence girdileri birden fazla kaynak tarafından üretilir ve **birleştirilir**.

### 1. Gateway öz girdisi

Gateway, başlatma sırasında her zaman bir “öz” girdisi ekler; böylece herhangi bir
istemci bağlanmadan önce bile arayüzlerde gateway ana makinesi görünür.

### 2. WebSocket bağlantısı

Her WS istemcisi bir `connect` isteğiyle başlar. Başarılı el sıkışma sonrasında
Gateway, bu bağlantı için bir presence girdisini ekler veya günceller.

#### Neden tek seferlik CLI komutları görünmez

CLI, kısa süreli tek seferlik komutlar için sıkça bağlanır. Instances listesini
spam’lememek için `client.mode === "cli"` bir presence girdisine **dönüştürülmez**.

### 3. `system-event` beacon’ları

İstemciler, `system-event` yöntemi aracılığıyla daha zengin periyodik beacon’lar
gönderebilir. mac uygulaması, ana makine adı, IP ve `lastInputSeconds` bildirmek için bunu kullanır.

### 4. Node bağlantıları (rol: node)

Bir node, Gateway WebSocket’i üzerinden `role: node` ile bağlandığında Gateway,
o node için bir presence girdisini ekler veya günceller (diğer WS istemcileriyle aynı akış).

## Birleştirme + yinelenenleri giderme (neden `instanceId` önemlidir)

Presence girdileri tek bir bellek içi haritada saklanır:

- Girdiler bir **presence anahtarı** ile anahtarlanır.
- En iyi anahtar, yeniden başlatmalardan sonra da kalıcı olan kararlı bir `instanceId`’dur (`connect.client.instanceId`’dan).
- Anahtarlar büyük/küçük harfe duyarsızdır.

Bir istemci kararlı bir `instanceId` olmadan yeniden bağlanırsa,
**yinelenen** bir satır olarak görünebilir.

## TTL ve sınırlı boyut

Presence bilerek geçicidir:

- **TTL:** 5 dakikadan eski girdiler budanır
- **Maks. girdi sayısı:** 200 (en eskiler önce düşürülür)

Bu, listenin taze kalmasını sağlar ve sınırsız bellek büyümesini önler.

## Uzak/tünel uyarısı (loopback IP’ler)

Bir istemci SSH tüneli / yerel port yönlendirme üzerinden bağlandığında, Gateway
uzak adresi `127.0.0.1` olarak görebilir. İstemci tarafından bildirilen iyi bir
IP’nin üzerine yazmamak için loopback uzak adresler yok sayılır.

## Tüketiciler

### macOS Instances sekmesi

macOS uygulaması, `system-presence` çıktısını oluşturur ve son güncellemenin yaşına göre
küçük bir durum göstergesi (Active/Idle/Stale) uygular.

## Hata ayıklama ipuçları

- Ham listeyi görmek için Gateway’e karşı `system-presence` çağrısını yapın.
- Yinelenenler görüyorsanız:
  - istemcilerin el sıkışmada kararlı bir `client.instanceId` gönderdiğini doğrulayın
  - periyodik beacon’ların aynı `instanceId`’yı kullandığını doğrulayın
  - bağlantıdan türetilen girdide `instanceId`’nin eksik olup olmadığını kontrol edin (bu durumda yinelenenler beklenir)
