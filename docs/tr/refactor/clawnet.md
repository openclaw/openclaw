---
summary: "Clawnet yeniden düzenleme: ağ protokolünü, rolleri, kimlik doğrulamayı, onayları ve kimliği birleştirme"
read_when:
  - Düğümler + operatör istemcileri için birleşik bir ağ protokolü planlanırken
  - Cihazlar genelinde onaylar, eşleştirme, TLS ve varlık (presence) yeniden ele alınırken
title: "Clawnet Yeniden Düzenleme"
---

# Clawnet yeniden düzenleme (protokol + kimlik doğrulama birleştirme)

## Merhaba

Merhaba Peter — harika bir yön; bu, daha basit bir UX ve daha güçlü bir güvenlik sağlıyor.

## Amaç

Şunlar için tek ve titiz bir belge:

- Mevcut durum: protokoller, akışlar, güven sınırları.
- Sorun noktaları: onaylar, çoklu atlama yönlendirme, UI çoğaltması.
- Önerilen yeni durum: tek protokol, kapsamlı roller, birleşik kimlik doğrulama/eşleştirme, TLS pinleme.
- Kimlik modeli: kalıcı ID’ler + sevimli slug’lar.
- Geçiş planı, riskler, açık sorular.

## Hedefler (görüşmeden)

- Tüm istemciler için tek protokol (mac uygulaması, CLI, iOS, Android, headless node).
- Ağdaki her katılımcının kimliği doğrulanmış + eşleştirilmiş olması.
- Rol netliği: node’lar ve operatörler.
- Merkezi onayların kullanıcının bulunduğu yere yönlendirilmesi.
- Tüm uzak trafik için TLS şifreleme + isteğe bağlı pinleme.
- Minimum kod tekrarları.
- Tek bir makinenin bir kez görünmesi (UI/node yinelenen girişi olmaması).

## Hedef olmayanlar (açıkça)

- Yetenek ayrımını kaldırmak (en az ayrıcalık hâlâ gerekli).
- Kapsam denetimleri olmadan tam gateway kontrol düzlemini açmak.
- Kimlik doğrulamayı insan etiketlerine bağlamak (slug’lar güvenlik dışıdır).

---

# Mevcut durum (as‑is)

## İki protokol

### 1. Gateway WebSocket (kontrol düzlemi)

- Tam API yüzeyi: yapılandırma, kanallar, modeller, oturumlar, ajan çalıştırmaları, günlükler, node’lar vb.
- Varsayılan bağlama: loopback. Uzak erişim SSH/Tailscale üzerinden.
- Kimlik doğrulama: `connect` ile belirteç/parola.
- TLS pinleme yok (loopback/tünel’e dayanır).
- Kod:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (node taşıması)

- Dar izin listesi yüzeyi, node kimliği + eşleştirme.
- TCP üzerinde JSONL; isteğe bağlı TLS + sertifika parmak izi pinleme.
- TLS, keşif TXT’sinde parmak izi ilan eder.
- Kod:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Bugünkü kontrol düzlemi istemcileri

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).
- macOS uygulama UI → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- Tarayıcı kontrolü kendi HTTP kontrol sunucusunu kullanır.

## Bugünkü node’lar

- Node modundaki macOS uygulaması Gateway bridge’e bağlanır (`MacNodeBridgeSession`).
- iOS/Android uygulamaları Gateway bridge’e bağlanır.
- Eşleştirme + node başına belirteç gateway’de saklanır.

## Mevcut onay akışı (exec)

- Ajan, Gateway üzerinden `system.run` kullanır.
- Gateway, bridge üzerinden node’u çağırır.
- Node runtime decides approval.
- UI istemi mac uygulaması tarafından gösterilir (node == mac uygulaması olduğunda).
- Node, Gateway’e `invoke-res` döndürür.
- Çoklu atlama, UI node ana makinesine bağlı.

## Varlık (presence) + kimlik bugün

- WS istemcilerinden Gateway varlık girdileri.
- Bridge’den node varlık girdileri.
- mac uygulaması aynı makine için iki girdi gösterebilir (UI + node).
- Node kimliği eşleştirme deposunda; UI kimliği ayrı.

---

# Sorunlar / ağrı noktaları

- Bakımı yapılacak iki protokol yığını (WS + Bridge).
- Uzak node’larda onaylar: istem, kullanıcının olduğu yerde değil node ana makinesinde görünür.
- TLS pinleme yalnızca bridge’de var; WS SSH/Tailscale’e dayanır.
- Kimlik çoğaltması: aynı makine birden fazla örnek olarak görünür.
- Belirsiz roller: UI + node + CLI yetenekleri net ayrılmamış.

---

# Önerilen yeni durum (Clawnet)

## Tek protokol, iki rol

Rol + kapsam içeren tek WS protokolü.

- **Rol: node** (yetenek ana makinesi)
- **Rol: operator** (kontrol düzlemi)
- Operator için isteğe bağlı **kapsam**:
  - `operator.read` (durum + görüntüleme)
  - `operator.write` (ajan çalıştırma, gönderimler)
  - `operator.admin` (yapılandırma, kanallar, modeller)

### Rol davranışları

**Node**

- Yetenekleri kaydedebilir (`caps`, `commands`, izinler).
- `invoke` komutlarını alabilir (`system.run`, `camera.*`, `canvas.*`, `screen.record` vb.).
- Olaylar gönderebilir: `voice.transcript`, `agent.request`, `chat.subscribe`.
- Yapılandırma/modeller/kanallar/oturumlar/ajan kontrol düzlemi API’lerini çağırmaz.

**Operator**

- Kapsamla kapatılmış tam kontrol düzlemi API’si.
- Tüm onayları alır.
- OS eylemlerini doğrudan yürütmez; node’lara yönlendirir.

### Temel kural

Rol bağlantı başınadır, cihaz başına değildir. Bir cihaz her iki rolü de ayrı ayrı açabilir.

---

# Birleşik kimlik doğrulama + eşleştirme

## İstemci kimliği

Her istemci şunları sağlar:

- `deviceId` (cihaz anahtarından türetilmiş, kalıcı).
- `displayName` (insan adı).
- `role` + `scope` + `caps` + `commands`.

## Eşleştirme akışı (birleşik)

- İstemci kimlik doğrulanmamış bağlanır.
- Gateway, ilgili `deviceId` için bir **eşleştirme isteği** oluşturur.
- Operator istem alır; onaylar/reddeder.
- Gateway, şu unsurlara bağlı kimlik bilgileri verir:
  - cihaz açık anahtarı
  - rol(ler)
  - kapsam(lar)
  - yetenekler/komutlar
- Client persists token, reconnects authenticated.

## Cihaza bağlı kimlik doğrulama (bearer belirteci tekrarını önleme)

Tercih edilen: cihaz anahtar çiftleri.

- Cihaz bir kez anahtar çifti üretir.
- `deviceId = fingerprint(publicKey)`.
- Gateway nonce gönderir; cihaz imzalar; gateway doğrular.
- Belirteçler bir dizeye değil, açık anahtara (sahiplik kanıtı) verilir.

Alternatifler:

- mTLS (istemci sertifikaları): en güçlü, daha fazla operasyonel karmaşıklık.
- Yalnızca geçici bir aşama olarak kısa ömürlü bearer belirteçleri (erken döndür + iptal).

## Sessiz onay (SSH sezgisi)

Zayıf halka olmaması için net tanımlayın. Şunlardan birini tercih edin:

- **Yalnızca yerel**: istemci loopback/Unix soketi üzerinden bağlandığında otomatik eşleştirme.
- **SSH ile meydan okuma**: gateway nonce verir; istemci bunu getirerek SSH’yi kanıtlar.
- **Fiziksel varlık penceresi**: gateway ana makinesi UI’sinde yerel bir onaydan sonra kısa bir süre (örn. 10 dakika) otomatik eşleştirmeye izin verin.

Her zaman otomatik onayları günlüğe alın + kaydedin.

---

# Her yerde TLS (dev + prod)

## Mevcut bridge TLS’yi yeniden kullanma

Mevcut TLS çalışma zamanı + parmak izi pinlemeyi kullanın:

- `src/infra/bridge/server/tls.ts`
- `src/node-host/bridge-client.ts` içindeki parmak izi doğrulama mantığı

## WS’ye uygulama

- WS sunucusu aynı sertifika/anahtar + parmak izi ile TLS’i destekler.
- WS istemcileri parmak izi pinleyebilir (isteğe bağlı).
- Keşif, tüm uç noktalar için TLS + parmak izi ilan eder.
  - Keşif yalnızca konum ipuçlarıdır; asla güven çıpası değildir.

## Neden

- Gizlilik için SSH/Tailscale’e bağımlılığı azaltmak.
- Uzak mobil bağlantıları varsayılan olarak güvenli yapmak.

---

# Onayların yeniden tasarımı (merkezi)

## Current

Onay, node ana makinesinde (mac uygulaması node çalışma zamanı) gerçekleşir. İstem, node’un çalıştığı yerde görünür.

## Önerilen

Onay **gateway barındırmalıdır**, UI operatör istemcilerine teslim edilir.

### Yeni akış

1. Gateway `system.run` intent’ini alır (ajan).
2. Gateway bir onay kaydı oluşturur: `approval.requested`.
3. Operator UI(ler)i istemi gösterir.
4. Onay kararı gateway’e gönderilir: `approval.resolve`.
5. Gateway onaylanırsa node komutunu çağırır.
6. Node yürütür, `invoke-res` döndürür.

### Onay semantiği (sertleştirme)

- Tüm operatörlere yayınlayın; yalnızca etkin UI modal gösterir (diğerleri toast alır).
- İlk çözüm kazanır; gateway sonraki çözümlemeleri zaten karara bağlandı diye reddeder.
- Varsayılan zaman aşımı: N saniye sonra reddet (örn. 60 sn), nedeni günlüğe al.
- Çözümleme `operator.approvals` kapsamı gerektirir.

## Faydalar

- İstem, kullanıcının olduğu yerde görünür (mac/telefon).
- Consistent approvals for remote nodes.
- Node çalışma zamanı headless kalır; UI bağımlılığı yoktur.

---

# Rol netliği örnekleri

## iPhone uygulaması

- **Node rolü**: mikrofon, kamera, sesli sohbet, konum, bas‑konuş.
- İsteğe bağlı **operator.read**: durum ve sohbet görünümü.
- Yalnızca açıkça etkinleştirildiğinde isteğe bağlı **operator.write/admin**.

## macOS uygulaması

- Varsayılan olarak operator rolü (kontrol UI).
- “Mac node” etkinleştirildiğinde node rolü (system.run, ekran, kamera).
- Her iki bağlantı için aynı deviceId → birleştirilmiş UI girişi.

## CLI

- Her zaman operator rolü.
- Kapsam alt komuta göre türetilir:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - onaylar + eşleştirme → `operator.approvals` / `operator.pairing`

---

# Kimlik + slug’lar

## Kalıcı ID

Kimlik doğrulama için gereklidir; asla değişmez.
Tercih edilen:

- Anahtar çifti parmak izi (açık anahtar özeti).

## Sevimli slug (ıstakoz temalı)

Yalnızca insan etiketi.

- Örnek: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Gateway kayıt defterinde saklanır, düzenlenebilir.
- Çakışma yönetimi: `-2`, `-3`.

## UI gruplama

Roller genelinde aynı `deviceId` → tek “Instance” satırı:

- Rozet: `operator`, `node`.
- Yetenekleri + son görülmeyi gösterir.

---

# Geçiş stratejisi

## Aşama 0: Belgele + hizala

- Bu belgeyi yayınla.
- Tüm protokol çağrılarını + onay akışlarını envantere al.

## Aşama 1: WS’ye roller/kapsamlar ekle

- `connect` parametrelerini `role`, `scope`, `deviceId` ile genişlet.
- Node rolü için izin listesi kapılaması ekle.

## Aşama 2: Bridge uyumluluğu

- Bridge’i çalışır durumda tut.
- Paralel olarak WS node desteği ekle.
- Özellikleri yapılandırma bayrağı arkasında kapıla.

## Aşama 3: Merkezi onaylar

- WS’ye onay isteği + çözümleme olaylarını ekle.
- mac uygulaması UI’sini istem + yanıt için güncelle.
- Node çalışma zamanı UI istemi göstermeyi bırakır.

## Aşama 4: TLS birleştirme

- Bridge TLS çalışma zamanını kullanarak WS için TLS yapılandırması ekle.
- Add pinning to clients.

## Aşama 5: Bridge’i kullanımdan kaldırma

- iOS/Android/mac node’u WS’ye taşı.
- Bridge’i yedek olarak tut; kararlı olunca kaldır.

## Aşama 6: Cihaza bağlı kimlik doğrulama

- Yerel olmayan tüm bağlantılar için anahtar tabanlı kimliği zorunlu kıl.
- İptal + döndürme UI’si ekle.

---

# Güvenlik notları

- Rol/izin listesi gateway sınırında uygulanır.
- Hiçbir istemci operator kapsamı olmadan “tam” API almaz.
- _Tüm_ bağlantılar için eşleştirme gereklidir.
- TLS + pinleme mobil için MITM riskini azaltır.
- SSH sessiz onayı bir kolaylıktır; yine de kaydedilir + iptal edilebilir.
- Keşif asla bir güven çıpası değildir.
- Yetenek iddiaları, platform/türe göre sunucu izin listelerine karşı doğrulanır.

# Akış + büyük yükler (node medya)

WS kontrol düzlemi küçük iletiler için uygundur, ancak node’lar ayrıca şunları yapar:

- kamera klipleri
- ekran kayıtları
- ses akışları

Seçenekler:

1. WS ikili çerçeveler + parçalama + geri basınç kuralları.
2. Ayrı bir akış uç noktası (yine TLS + kimlik doğrulama).
3. Medya ağırlıklı komutlar için bridge’i daha uzun süre tutup en son taşımak.

Sürüklenmeyi önlemek için uygulamadan önce birini seçin.

# Yetenek + komut politikası

- Node tarafından bildirilen yetenekler/komutlar **iddia** olarak ele alınır.
- Gateway, platform başına izin listelerini uygular.
- Her yeni komut, operatör onayı veya açık bir izin listesi değişikliği gerektirir.
- Değişiklikleri zaman damgalarıyla denetleyin.

# Denetim + hız sınırlama

- Günlükle: eşleştirme istekleri, onaylar/reddler, belirteç verme/döndürme/iptal.
- Eşleştirme spam’ini ve onay istemlerini hız sınırlamasına tabi tut.

# Protokol hijyeni

- Açık protokol sürümü + hata kodları.
- Yeniden bağlanma kuralları + heartbeat politikası.
- Varlık TTL ve son görülme semantiği.

---

# Açık sorular

1. Her iki rolü de çalıştıran tek cihaz: belirteç modeli
   - Rol başına ayrı belirteçler önerilir (node vs operator).
   - Aynı deviceId; farklı kapsamlar; daha net iptal.

2. Operator kapsam ayrıntı düzeyi
   - read/write/admin + onaylar + eşleştirme (asgari uygulanabilir).
   - Consider per‑feature scopes later.

3. Belirteç döndürme + iptal UX’i
   - Rol değişikliğinde otomatik döndürme.
   - deviceId + rol bazında iptal UI’si.

4. Keşif
   - Mevcut Bonjour TXT’yi WS TLS parmak izi + rol ipuçlarını içerecek şekilde genişletin.
   - Yalnızca konum ipuçları olarak ele alın.

5. Cross‑network approval
   - Tüm operatör istemcilerine yayınlayın; etkin UI modal gösterir.
   - İlk yanıt kazanır; gateway atomikliği uygular.

---

# Özet (TL;DR)

- Bugün: WS kontrol düzlemi + Bridge node taşıması.
- Ağrı: onaylar + çoğaltma + iki yığın.
- Öneri: açık roller + kapsamlarla tek WS protokolü, birleşik eşleştirme + TLS pinleme, gateway barındırmalı onaylar, kalıcı cihaz ID’leri + sevimli slug’lar.
- Sonuç: daha basit UX, daha güçlü güvenlik, daha az tekrar, daha iyi mobil yönlendirme.
