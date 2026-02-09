---
summary: "OpenClaw’da Qwen OAuth’u (ücretsiz katman) kullanın"
read_when:
  - OpenClaw ile Qwen kullanmak istiyorsunuz
  - Qwen Coder için ücretsiz katman OAuth erişimi istiyorsunuz
title: "Qwen"
---

# Qwen

Qwen, Qwen Coder ve Qwen Vision modelleri için ücretsiz katmanlı bir OAuth akışı sunar
(günde 2.000 istek, Qwen hız limitlerine tabidir).

## Eklentiyi etkinleştirin

```bash
openclaw plugins enable qwen-portal-auth
```

Etkinleştirdikten sonra Gateway’i yeniden başlatın.

## Kimlik Doğrulama

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Bu, Qwen cihaz-kodu OAuth akışını çalıştırır ve
`models.json` dosyanıza bir sağlayıcı girişi yazar
(hızlı geçiş için bir `qwen` takma adıyla birlikte).

## Model Kimlikleri

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Modelleri şu komutla değiştirin:

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen Code CLI oturumunu yeniden kullanma

Qwen Code CLI ile zaten oturum açtıysanız, OpenClaw kimlik bilgilerini
kimlik doğrulama deposunu yüklerken `~/.qwen/oauth_creds.json` konumundan senkronize eder. Yine de
bir `models.providers.qwen-portal` girdisine ihtiyacınız vardır (oluşturmak için yukarıdaki giriş komutunu kullanın).

## Notlar

- Belirteçler otomatik yenilenir; yenileme başarısız olursa veya erişim iptal edilirse giriş komutunu yeniden çalıştırın.
- Varsayılan temel URL: `https://portal.qwen.ai/v1` (Qwen farklı bir uç nokta sağlarsa
  `models.providers.qwen-portal.baseUrl` ile geçersiz kılın).
- Sağlayıcı genelindeki kurallar için [Model providers](/concepts/model-providers) bölümüne bakın.
