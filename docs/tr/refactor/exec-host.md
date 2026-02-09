---
summary: "Refaktör planı: exec ana makinesi yönlendirmesi, düğüm onayları ve başsız çalıştırıcı"
read_when:
  - Exec ana makinesi yönlendirmesi veya exec onayları tasarlanırken
  - Düğüm çalıştırıcısı + UI IPC uygulanırken
  - Exec ana makinesi güvenlik modları ve slash komutları eklenirken
title: "Exec Host Refactor"
---

# Exec ana makinesi refaktör planı

## Hedefler

- Yürütmeyi **sandbox**, **gateway** ve **node** arasında yönlendirmek için `exec.host` + `exec.security` eklemek.
- Varsayılanları **güvenli** tutmak: açıkça etkinleştirilmedikçe ana makineler arası yürütme yok.
- Yürütmeyi, yerel IPC üzerinden isteğe bağlı UI (macOS uygulaması) ile **başsız bir çalıştırıcı hizmeti** olarak ayırmak.
- **Ajan başına** politika, izin listesi, sorma modu ve düğüm bağlama sağlamak.
- İzin listeleriyle _birlikte_ veya _izin listesi olmadan_ çalışan **sorma modlarını** desteklemek.
- Platformlar arası: Unix soketi + belirteç kimlik doğrulaması (macOS/Linux/Windows eşitliği).

## Hedef dışı

- Eski izin listesi geçişi veya eski şema desteği yok.
- Düğüm exec için PTY/akış yok (yalnızca toplu çıktı).
- Mevcut Bridge + Gateway dışında yeni ağ katmanı yok.

## Decisions (locked)

- **Yapılandırma anahtarları:** `exec.host` + `exec.security` (ajan başına geçersiz kılma izinli).
- **Yükseltme:** `/elevated`’yı gateway tam erişimi için takma ad olarak tut.
- **Sorma varsayılanı:** `on-miss`.
- **Onaylar deposu:** `~/.openclaw/exec-approvals.json` (JSON, eski geçiş yok).
- **Çalıştırıcı:** başsız sistem hizmeti; UI uygulaması onaylar için bir Unix soketi barındırır.
- **Düğüm kimliği:** mevcut `nodeId` kullanılır.
- **Soket kimlik doğrulaması:** Unix soketi + belirteç (platformlar arası); gerekirse sonra ayrılır.
- **Düğüm ana makinesi durumu:** `~/.openclaw/node.json` (düğüm kimliği + eşleştirme belirteci).
- **macOS exec ana makinesi:** `system.run`’i macOS uygulamasının içinde çalıştır; düğüm ana makinesi hizmeti istekleri yerel IPC üzerinden iletir.
- **XPC yardımcı yok:** Unix soketi + belirteç + eş denetimleriyle devam.

## Temel kavramlar

### Host

- `sandbox`: Docker exec (mevcut davranış).
- `gateway`: gateway ana makinesinde exec.
- `node`: Bridge (`system.run`) üzerinden düğüm çalıştırıcısında exec.

### Güvenlik modu

- `deny`: her zaman engelle.
- `allowlist`: yalnızca eşleşenlere izin ver.
- `full`: her şeye izin ver (yükseltilmiş ile eşdeğer).

### Ask mode

- `off`: asla sorma.
- `on-miss`: izin listesi eşleşmediğinde sor.
- `always`: her seferinde sor.

Sorma, izin listesinden **bağımsızdır**; izin listesi `always` veya `on-miss` ile birlikte kullanılabilir.

### Politika çözümü (exec başına)

1. `exec.host`’ü çöz (araç parametresi → ajan geçersiz kılması → küresel varsayılan).
2. `exec.security` ve `exec.ask`’yı çöz (aynı öncelik).
3. Ana makine `sandbox` ise, yerel sandbox exec ile devam et.
4. Ana makine `gateway` veya `node` ise, o ana makinede güvenlik + sorma politikasını uygula.

## Varsayılan güvenlik

- Varsayılan `exec.host = sandbox`.
- `gateway` ve `node` için varsayılan `exec.security = deny`.
- Varsayılan `exec.ask = on-miss` (yalnızca güvenlik izin veriyorsa geçerli).
- Düğüm bağlama ayarlanmadıysa, **ajan herhangi bir düğümü hedefleyebilir**, ancak yalnızca politika izin verirse.

## Yapılandırma yüzeyi

### Araç parametreleri

- `exec.host` (isteğe bağlı): `sandbox | gateway | node`.
- `exec.security` (isteğe bağlı): `deny | allowlist | full`.
- `exec.ask` (isteğe bağlı): `off | on-miss | always`.
- `exec.node` (isteğe bağlı): `host=node` olduğunda kullanılacak düğüm kimliği/adı.

### Yapılandırma anahtarları (küresel)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (varsayılan düğüm bağlama)

### Yapılandırma anahtarları (ajan başına)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = ajan oturumu için `tools.exec.host=gateway`, `tools.exec.security=full` ayarla.
- `/elevated off` = ajan oturumu için önceki exec ayarlarını geri yükle.

## Approvals store (JSON)

Yol: `~/.openclaw/exec-approvals.json`

Amaç:

- **Yürütme ana makinesi** (gateway veya düğüm çalıştırıcısı) için yerel politika + izin listeleri.
- UI mevcut olmadığında sorma için geri dönüş.
- UI istemcileri için IPC kimlik bilgileri.

Önerilen şema (v1):

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

Notlar:

- Eski izin listesi biçimleri yok.
- `askFallback`, yalnızca `ask` gerektiğinde ve UI erişilebilir olmadığında uygulanır.
- Dosya izinleri: `0600`.

## Çalıştırıcı hizmeti (başsız)

### Rol

- Yerelde `exec.security` + `exec.ask`’ı uygular.
- Sistem komutlarını yürütür ve çıktıyı döndürür.
- Exec yaşam döngüsü için Bridge olayları yayar (isteğe bağlı ama önerilir).

### Hizmet yaşam döngüsü

- macOS’ta launchd/daemon; Linux/Windows’ta sistem hizmeti.
- Approvals JSON is local to the execution host.
- UI yerel bir Unix soketi barındırır; çalıştırıcılar gerektiğinde bağlanır.

## UI entegrasyonu (macOS uygulaması)

### IPC

- Unix soketi: `~/.openclaw/exec-approvals.sock` (0600).
- Belirteç şurada saklanır: `exec-approvals.json` (0600).
- Eş denetimleri: yalnızca aynı UID.
- Meydan okuma/yanıt: yeniden oynatmayı önlemek için nonce + HMAC(token, istek-özeti).
- Kısa TTL (örn. 10 sn) + azami yük + hız sınırı.

### Sorma akışı (macOS uygulaması exec ana makinesi)

1. Düğüm hizmeti, gateway’den `system.run` alır.
2. Düğüm hizmeti yerel sokete bağlanır ve istemi/exec isteğini gönderir.
3. Uygulama eş + belirteç + HMAC + TTL’i doğrular, gerekirse iletişim kutusunu gösterir.
4. Uygulama komutu UI bağlamında yürütür ve çıktıyı döndürür.
5. Düğüm hizmeti çıktıyı gateway’e döndürür.

UI yoksa:

- `askFallback` (`deny|allowlist|full`) uygulanır.

### Diyagram (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Düğüm kimliği + bağlama

- Bridge eşleştirmesinden mevcut `nodeId`’yı kullan.
- Bağlama modeli:
  - `tools.exec.node`, ajanı belirli bir düğümle sınırlar.
  - Ayarlanmadıysa, ajan herhangi bir düğümü seçebilir (politika yine varsayılanları uygular).
- Düğüm seçimi çözümü:
  - `nodeId` tam eşleşme
  - `displayName` (normalize edilmiş)
  - `remoteIp`
  - `nodeId` önek (>= 6 karakter)

## Olaylama

### Olayları kim görür

- Sistem olayları **oturum başına**dır ve bir sonraki istemde ajana gösterilir.
- Gateway içi bellek kuyruğunda saklanır (`enqueueSystemEvent`).

### Olay metni

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + isteğe bağlı çıktı kuyruğu
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Taşıma

Seçenek A (önerilen):

- Çalıştırıcı Bridge `event` çerçevelerini `exec.started` / `exec.finished` gönderir.
- Gateway `handleBridgeEvent`, bunları `enqueueSystemEvent`’a eşler.

Seçenek B:

- Gateway `exec` aracı yaşam döngüsünü doğrudan ele alır (yalnızca eşzamanlı).

## Exec akışları

### Sandbox ana makinesi

- Mevcut `exec` davranışı (Docker veya sandbox dışıyken ana makine).
- PTY yalnızca sandbox dışı modda desteklenir.

### Gateway ana makinesi

- Gateway süreci kendi makinesinde yürütür.
- Yerel `exec-approvals.json`’ü (güvenlik/sorma/izin listesi) uygular.

### Node host

- Gateway, `system.run` ile `node.invoke` çağrısı yapar.
- Çalıştırıcı yerel onayları uygular.
- Çalıştırıcı toplu stdout/stderr döndürür.
- Başlangıç/bitiş/red için isteğe bağlı Bridge olayları.

## Output caps

- Birleşik stdout+stderr’i **200k** ile sınırla; olaylar için **20k kuyruk** tut.
- Açık bir sonek ile kırp (örn. `"… (truncated)"`).

## Slash komutları

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Ajan başına, oturum başına geçersiz kılmalar; yapılandırma ile kaydedilmedikçe kalıcı değildir.
- `/elevated on|off|ask|full`, `full` ile onayları atlayarak `host=gateway security=full` için kısayol olarak kalır.

## Platformlar arası hikâye

- Çalıştırıcı hizmeti taşınabilir yürütme hedefidir.
- UI isteğe bağlıdır; yoksa `askFallback` uygulanır.
- Windows/Linux aynı onaylar JSON’u + soket protokolünü destekler.

## Uygulama aşamaları

### Aşama 1: yapılandırma + exec yönlendirme

- `exec.host`, `exec.security`, `exec.ask`, `exec.node` için yapılandırma şeması ekle.
- Araç tesisatını `exec.host`’ya saygı duyacak şekilde güncelle.
- `/exec` slash komutunu ekle ve `/elevated` takma adını koru.

### Aşama 2: onaylar deposu + gateway zorlaması

- `exec-approvals.json` okuyucu/yazıcıyı uygula.
- `gateway` ana makinesi için izin listesi + sorma modlarını uygula.
- Add output caps.

### Aşama 3: düğüm çalıştırıcı zorlaması

- Düğüm çalıştırıcıyı izin listesi + sorma uygulayacak şekilde güncelle.
- macOS uygulaması UI’sine Unix soketi istem köprüsünü ekle.
- `askFallback`’i bağla.

### Aşama 4: olaylar

- Exec yaşam döngüsü için düğüm → gateway Bridge olaylarını ekle.
- Ajan istemleri için `enqueueSystemEvent`’ye eşle.

### Aşama 5: UI cilası

- Mac uygulaması: izin listesi düzenleyici, ajan başına değiştirici, sorma politikası UI.
- Düğüm bağlama kontrolleri (isteğe bağlı).

## Test planı

- Birim testleri: izin listesi eşleştirme (glob + büyük/küçük harfe duyarsız).
- Birim testleri: politika çözümü önceliği (araç parametresi → ajan geçersiz kılması → küresel).
- Entegrasyon testleri: düğüm çalıştırıcı reddetme/izin verme/sorma akışları.
- Bridge olay testleri: düğüm olayı → sistem olayı yönlendirme.

## Açık riskler

- UI kullanılamazlığı: `askFallback`’ün uygulandığından emin olun.
- Uzun süreli komutlar: zaman aşımı + çıktı sınırlarına güvenin.
- Çoklu düğüm belirsizliği: düğüm bağlama veya açık düğüm parametresi yoksa hata.

## İlgili belgeler

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
