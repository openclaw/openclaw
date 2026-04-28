# Ceviz Harness Modeli

## 1. Amaç

Bu dokümanın amacı, şimdiye kadar oluşan mimariyi daha net isimlendirmek ve Ceviz’in sistem içindeki rolünü berraklaştırmaktır.

Bugüne kadar yaptığımız işlerde fiilen ortaya çıkan model şudur:

> Ceviz, orkestratör ve reasoning katmanıdır.
> Dış dünyadaki uygulamalarla, araçlarla ve ajanlarla doğrudan kendisi uğraşmak yerine,
> bunu kontrollü harness/executor katmanları üzerinden yapar.

Bu model hem CAD/BIM copilot için hem de gelecekte başka domain’ler için tekrar kullanılabilir.

---

## 2. Temel kavramlar

## 2.1 Ceviz

Ceviz’in rolü:

- niyeti anlamak
- görevi parçalamak
- hangi uygulayıcı katmanın kullanılacağını seçmek
- veriyi yorumlamak
- cevabı üretmek
- güvenlik ve kapsam sınırını korumak

Ceviz’in görevi doğrudan her şeyi yapmak değildir.
Ceviz’in görevi:
**neyin, neden, hangi yolla yapılacağını belirlemek ve sonuçları birleştirmektir.**

Yani Ceviz:

- planner
- orchestrator
- reasoner
- policy-aware coordinator

rolünü taşır.

---

## 2.2 Harness

Harness, Ceviz ile dış dünyadaki bir sistem arasındaki kontrollü bağlantı katmanıdır.

Harness’in temel amacı:

- dış sistemle konuşmak
- çağrıları sınırlandırmak
- veri alışverişini normalize etmek
- hata/fallback davranışını standartlaştırmak
- Ceviz’i host/tool bağımlılığından korumak

Kısaca:

> Harness, Ceviz’in elleri değildir.
> Eller ile dünya arasındaki güvenli eldivendir.

### Harness neler içerir?

- command surface
- request/response contract
- transport mekanizması
- error model
- fallback davranışı
- capability sınırları
- mümkünse logging / observability

---

## 2.3 Executor

Executor, harness’in içindeki fiili uygulayıcı parçadır.

Örneğin:

- Windows helper process
- SolidWorks COM extractor
- Outlook/Graph mail worker
- browser automation worker
- bir ACP ajan oturumu

Executor’un görevi yorum yapmak değil, işi uygulamaktır.

Ceviz:

- “ne yapılacak?”
- “hangi bağlam gerekli?”
- “hangi çıktı önemli?”

sorularını yönetir.

Executor ise:

- “şu hosttan veri al”
- “şu komutu çalıştır”
- “şu artifact’i üret”

gibi daha mekanik işleri yapar.

---

## 2.4 Rules / Policy Layer

Bu katman hem Ceviz’e hem harness’e sınır koyar.

Görevleri:

- hangi komutlar izinli
- hangi işlemler read-only
- hangi write işlemleri approval ister
- hangi alanlar zorunlu
- hangi hatalar nasıl raporlanmalı

Bu katman sayesinde sistem “sadece akıllı” değil,
aynı zamanda **kontrollü ve güvenilir** olur.

---

## 3. Neden bu model gerekli?

Ceviz’in doğrudan:

- SolidWorks API’si
- Windows COM objeleri
- Outlook/Graph erişimi
- browser kontrolü
- harici coding harness’leri
  ile tek katmanda uğraşması doğru değil.

### Sebepler

1. bağımlılık patlaması olur
2. hata yönetimi dağılır
3. güvenlik sınırı kaybolur
4. test edilebilirlik zorlaşır
5. çok-host genişleme yönetilemez hale gelir

Harness modeli bu yüzden gerekli.

---

## 4. Bugüne kadar çıkan fiili mimari

Şimdiye kadar ortaya çıkan yapı fiilen şu:

### Katmanlar

1. **Ceviz / Orchestrator**
2. **Harness boundary**
3. **Executor / Host integration**
4. **Target system**

Bunu örnekleyelim.

---

## 5. CAD/BIM örneği

### Akış

1. Kullanıcı: “Bu modeli bana açıkla” der.
2. Ceviz bunun `get-active-document`, `get-document-metadata`, `get-assembly-summary` gerektirdiğine karar verir.
3. SolidWorks harness devreye girer.
4. Windows executor / extractor host uygulamadan veriyi okur.
5. Veri normalize edilmiş contract olarak geri döner.
6. Ceviz bunu yorumlayıp kullanıcıya cevap üretir.

### Burada roller

- **Ceviz**: intent + reasoning + cevap
- **Harness**: contract + transport + fallback
- **Executor**: SolidWorks COM/API erişimi
- **Host**: SolidWorks

---

## 6. Codex / ACP örneği

Bu model sadece CAD için değil.

### Akış

1. Kullanıcı: “Bunu Codex’e yaptır” der.
2. Ceviz görevi scoped hale getirir.
3. ACP/Codex harness devreye girer.
4. Codex session görevi işler.
5. Çıktı geri gelir.
6. Ceviz sonucu değerlendirip kullanıcıya raporlar.

### Burada roller

- **Ceviz**: scope, delegasyon, kalite kontrol
- **Harness**: ACP/runtime/session boundary
- **Executor**: Codex oturumu
- **Target**: coding agent

Yani Codex de aslında farklı bir harness kanalından çalışan executor gibi düşünülebilir.

---

## 7. Windows bridge / Outlook örneği

### Akış

1. Ceviz mail taraması gerektiğine karar verir.
2. Windows/Graph harness çağrılır.
3. Auth / request / paging / artifact üretimi executor tarafından yapılır.
4. Sonuçlar normalize edilir.
5. Ceviz öne çıkanları yorumlar.

Burada da aynı pattern vardır.

---

## 8. Bu modelde Ceviz ne değildir?

Ceviz:

- her uygulamanın API uzmanı değildir
- doğrudan her hosta yapışan monolit değildir
- her işi kendisi çalıştırmak zorunda olan worker değildir
- shell script yığını değildir

Ceviz’in değeri:

- doğru işi doğru executor’a yönlendirmesi
- çıktıyı anlamlandırması
- sınırları koruması
- sistemi bir bütün olarak tutmasıdır

---

## 9. Şimdiye kadar yaptığımız işlerin bu modele katkısı

### Ürün tarafı

- discovery
- PRD
- teknik mimari

Bunlar “neden bu sistemi kuruyoruz?” sorusunu cevapladı.

### Harness tarafı

- Windows bridge yaklaşımı
- queue request/response modeli
- command surface
- context contract
- shared handler seam
- typed error modeli
- fallback mantığı
- live extractor boundary

Bunlar “sistemi kontrollü nasıl uygularız?” sorusunu cevapladı.

Dolayısıyla bugüne kadar yapılan teknik işin büyük bölümü fiilen harness modelini ortaya çıkardı.

---

## 10. Harness modelinin güçlü tarafları

### 10.1 Ayrışma

Ceviz ile host entegrasyonu ayrılır.

### 10.2 Güvenlik

Allowlist command surface ve approval boundary kurulabilir.

### 10.3 Genişleme

Yeni host/application eklemek kolaylaşır.

### 10.4 Test edilebilirlik

Seeded probe, stub, live-only, prefer-live gibi modlar denenebilir.

### 10.5 Taşınabilirlik

Aynı desen farklı problem alanlarında çalışır.

---

## 11. Riskler

### 11.1 Aşırı soyutlama

Harness’i fazla genel kurarsak gerçek işten kopabiliriz.

### 11.2 Gereksiz katmanlaşma

Basit işlerde gereksiz karmaşıklık olabilir.

### 11.3 Yarım entegrasyonlar

Harness kurulup gerçek executor bağlanmazsa sistem demo seviyesinde kalır.

### 11.4 Contract şişmesi

Çok erken çok büyük veri sözleşmeleri kurmak ilerlemeyi yavaşlatabilir.

Bu yüzden prensip şu olmalı:

> Minimum işe yarar harness,
> sonra gerçek host entegrasyonu,
> sonra genişleme.

---

## 12. Ceviz için önerilen çalışma ilkesi

Bence Ceviz bundan sonra şu prensiple ilerlemeli:

### Ceviz yapar

- problem çerçevesi kurar
- mimari karar verir
- görevleri paketler
- delegasyon yapar
- sonuçları değerlendirir
- kullanıcıya bağlamsal cevap üretir

### Harness yapar

- dış sistemle konuşur
- veri toplar
- komut uygular
- response/error contract üretir

### Executor yapar

- fiili host/API işlemini gerçekleştirir

Bu ayrım korunursa sistem hem daha güçlü hem daha sürdürülebilir olur.

---

## 13. Net sonuç

Şu anda oluşan model şu cümleyle özetlenebilir:

> **Ceviz, merkezi orchestrator ve reasoning katmanıdır.**
> **Harness’ler, Ceviz ile dış sistemler arasındaki kontrollü uygulama köprüleridir.**
> **Executor’lar ise bu harness’lerin içindeki fiili uygulayıcılardır.**

Bu model:

- CAD/BIM copilot
- Windows bridge
- Outlook/Graph işleri
- Codex/ACP delegasyonu
- ileride başka profesyonel uygulamalar

için ortak bir temel olabilir.

---

## 14. Kısa karar özeti

Bu dokümandan çıkarılacak ana kararlar:

- Ceviz’in rolü: **orchestrator / planner / reasoner**
- harness’in rolü: **controlled boundary / integration layer**
- executor’un rolü: **host-specific worker**
- sistem yaklaşımı: **contract-first, policy-aware, host-agnostic where possible**
- teknik işlerin büyük kısmı bugüne kadar fiilen bu harness modelini kurmaya hizmet etti
