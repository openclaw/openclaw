---
summary: "Keşif: model yapılandırması, kimlik doğrulama profilleri ve geri dönüş davranışı"
read_when:
  - Gelecekteki model seçimi + kimlik doğrulama profili fikirlerini keşfederken
title: "Model Yapılandırması Keşfi"
---

# Model Yapılandırması (Keşif)

Bu belge, gelecekteki model yapılandırması için **fikirleri** kaydeder. Sevkiyatı yapılan bir teknik şartname değildir. Mevcut davranış için bkz.:

- [Modeller](/concepts/models)
- [Model devre dışı kalma durumunda geçiş](/concepts/model-failover)
- [OAuth + profiller](/concepts/oauth)

## Motivasyon

Operatörler şunları ister:

- Sağlayıcı başına birden fazla kimlik doğrulama profili (kişisel vs iş).
- Öngörülebilir geri dönüşlerle basit `/model` seçimi.
- Metin modelleri ile görüntü yetenekli modeller arasında net ayrım.

## Olası yön (üst düzey)

- Model seçimini basit tutun: isteğe bağlı takma adlarla `provider/model`.
- Sağlayıcıların açık bir sırayla birden fazla kimlik doğrulama profiline sahip olmasına izin verin.
- Tüm oturumların tutarlı biçimde geri dönmesi için küresel bir geri dönüş listesi kullanın.
- Yalnızca açıkça yapılandırıldığında görüntü yönlendirmesini geçersiz kılın.

## Açık sorular

- Profil rotasyonu sağlayıcı başına mı yoksa model başına mı olmalı?
- UI, bir oturum için profil seçimini nasıl sunmalı?
- Eski yapılandırma anahtarlarından en güvenli geçiş yolu nedir?
