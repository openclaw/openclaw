---
summary: "OpenClaw’ın kimlik doğrulama profillerini nasıl döndürdüğü ve modeller arasında nasıl geri dönüş yaptığı"
read_when:
  - Kimlik doğrulama profili rotasyonu, bekleme süreleri veya model geri dönüşü davranışını teşhis ederken
  - Kimlik doğrulama profilleri veya modeller için failover kurallarını güncellerken
title: "Model Failover"
---

# Model failover

OpenClaw, hataları iki aşamada ele alır:

1. Mevcut sağlayıcı içinde **kimlik doğrulama profili rotasyonu**.
2. `agents.defaults.model.fallbacks` içindeki bir sonraki modele **model geri dönüşü**.

Bu doküman, çalışma zamanı kurallarını ve bunları destekleyen verileri açıklar.

## Kimlik doğrulama depolaması (anahtarlar + OAuth)

OpenClaw, hem API anahtarları hem de OAuth belirteçleri için **kimlik doğrulama profilleri** kullanır.

- Gizli bilgiler `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`’te bulunur (eski: `~/.openclaw/agent/auth-profiles.json`).
- Yapılandırma `auth.profiles` / `auth.order` **yalnızca meta veriler + yönlendirme** içindir (gizli bilgi yok).
- Eski yalnızca‑içe‑aktarım OAuth dosyası: `~/.openclaw/credentials/oauth.json` (ilk kullanımda `auth-profiles.json` içine aktarılır).

Daha fazla ayrıntı: [/concepts/oauth](/concepts/oauth)

Kimlik bilgisi türleri:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ bazı sağlayıcılar için `projectId`/`enterpriseUrl`)

## Profil Kimlikleri

OAuth oturum açmaları, birden fazla hesabın birlikte var olabilmesi için ayrı profiller oluşturur.

- Varsayılan: e‑posta yoksa `provider:default`.
- E‑postalı OAuth: `provider:<email>` (örneğin `google-antigravity:user@gmail.com`).

Profiller, `profiles` altında `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` içinde bulunur.

## Rotasyon sırası

Bir sağlayıcının birden fazla profili olduğunda, OpenClaw sıralamayı şu şekilde seçer:

1. **Açık yapılandırma**: `auth.order[provider]` (ayarlanmışsa).
2. **Yapılandırılmış profiller**: sağlayıcıya göre filtrelenmiş `auth.profiles`.
3. **Depolanmış profiller**: sağlayıcı için `auth-profiles.json` içindeki girdiler.

Açık bir sıra yapılandırılmamışsa, OpenClaw round‑robin sırası kullanır:

- **Birincil anahtar:** profil türü (**OAuth, API anahtarlarından önce**).
- **İkincil anahtar:** `usageStats.lastUsed` (her tür içinde eskiden yeniye).
- **Beklemede/devre dışı profiller** sona taşınır ve en erken bitişe göre sıralanır.

### Session stickiness (cache-friendly)

OpenClaw, sağlayıcı önbelleklerini sıcak tutmak için **seçilen kimlik doğrulama profilini oturum başına sabitler**.
Her istekte rotasyon yapmaz. Sabitlenen profil şu durumlara kadar yeniden kullanılır:

- oturum sıfırlanırsa (`/new` / `/reset`)
- bir sıkıştırma tamamlanırsa (sıkıştırma sayacı artar)
- profil bekleme süresinde/devre dışı

`/model …@<profileId>` üzerinden manuel seçim, o oturum için bir **kullanıcı geçersiz kılması** ayarlar
ve yeni bir oturum başlayana kadar otomatik olarak döndürülmez.

Otomatik olarak sabitlenen profiller (oturum yönlendiricisi tarafından seçilenler) bir **tercih** olarak ele alınır:
önce denenirler, ancak OpenClaw hız limitleri/zaman aşımlarında başka bir profile dönebilir.
Kullanıcı tarafından sabitlenen profiller o profile kilitli kalır; başarısız olursa ve model geri dönüşleri
yapılandırılmışsa, OpenClaw profil değiştirmek yerine bir sonraki modele geçer.

### OAuth neden “kaybolmuş gibi” görünebilir

Aynı sağlayıcı için hem bir OAuth profili hem de bir API anahtarı profili varsa, round‑robin sabitleme yapılmadıkça iletiler arasında bunlar arasında geçiş yapabilir. Tek bir profili zorlamak için:

- `auth.order[provider] = ["provider:profileId"]` ile sabitleyin veya
- (Kullandığınız UI/sohbet yüzeyi destekliyorsa) profil geçersiz kılmasıyla `/model …` üzerinden oturum başına geçersiz kılma kullanın.

## Cooldowns

Bir profil, kimlik doğrulama/hız limiti hataları (ya da hız sınırlaması gibi görünen bir zaman aşımı) nedeniyle başarısız olduğunda, OpenClaw onu beklemeye alır ve bir sonraki profile geçer.
Biçim/geçersiz‑istek hataları (örneğin Cloud Code Assist araç çağrısı kimliği doğrulama hataları) da
failover’a uygun kabul edilir ve aynı bekleme sürelerini kullanır.

Bekleme süreleri üstel geri çekilme kullanır:

- 1 dakika
- 5 dakika
- 25 dakika
- 1 saat (üst sınır)

Durum, `usageStats` altında `auth-profiles.json`’da saklanır:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Faturalama nedeniyle devre dışı bırakma

Faturalama/kredi hataları (örneğin “yetersiz kredi” / “kredi bakiyesi çok düşük”) failover’a uygun kabul edilir, ancak genellikle geçici değildir. Kısa bir bekleme süresi yerine, OpenClaw profili **devre dışı** olarak işaretler (daha uzun bir geri çekilme ile) ve bir sonraki profil/sağlayıcıya döner.

Durum, `auth-profiles.json`’de saklanır:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Varsayılanlar:

- Faturalama geri çekilmesi **5 saat** ile başlar, her faturalama hatasında iki katına çıkar ve **24 saat**te sınırlandırılır.
- Profil **24 saat** boyunca başarısız olmazsa geri çekilme sayaçları sıfırlanır (yapılandırılabilir).

## Model geri dönüşü

Bir sağlayıcı için tüm profiller başarısız olursa, OpenClaw `agents.defaults.model.fallbacks` içindeki bir sonraki modele geçer. Bu; kimlik doğrulama hataları, hız limitleri ve profil rotasyonunu tüketen zaman aşımları için geçerlidir
(diğer hatalar geri dönüşü ilerletmez).

Bir çalıştırma model geçersiz kılmasıyla (hook’lar veya CLI) başlarsa, yapılandırılmış geri dönüşler denendikten sonra geri dönüşler yine `agents.defaults.model.primary`’te sona erer.

## İlgili yapılandırma

Aşağıdakiler için [Gateway yapılandırması](/gateway/configuration)’na bakın:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` yönlendirmesi

Daha geniş model seçimi ve geri dönüş genel bakışı için [Modeller](/concepts/models)’e bakın.
