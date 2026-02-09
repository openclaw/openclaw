---
summary: "`openclaw models` için CLI referansı (durum/listele/ayarla/tara, takma adlar, yedekler, kimlik doğrulama)"
read_when:
  - Varsayılan modelleri değiştirmek veya sağlayıcı kimlik doğrulama durumunu görüntülemek istediğinizde
  - Mevcut modelleri/sağlayıcıları taramak ve kimlik doğrulama profillerini hata ayıklamak istediğinizde
title: "modeller"
---

# `openclaw models`

Model keşfi, tarama ve yapılandırma (varsayılan model, yedekler, kimlik doğrulama profilleri).

İlgili:

- Sağlayıcılar + modeller: [Models](/providers/models)
- Sağlayıcı kimlik doğrulama kurulumu: [Getting started](/start/getting-started)

## Yaygın komutlar

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status`, çözümlenmiş varsayılan/yedekleri ve bir kimlik doğrulama genel görünümünü gösterir.
Sağlayıcı kullanım anlık görüntüleri mevcut olduğunda, OAuth/belirteç durumu bölümü
sağlayıcı kullanım başlıklarını içerir.
Her yapılandırılmış sağlayıcı profiline karşı canlı kimlik doğrulama yoklamaları çalıştırmak için `--probe` ekleyin.
Yoklamalar gerçek isteklerdir (belirteç tüketebilir ve hız sınırlarını tetikleyebilir).
Yapılandırılmış bir ajanın model/kimlik doğrulama durumunu incelemek için `--agent <id>` kullanın. Atlanırsa,
komut ayarlıysa `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`’i, aksi halde
yapılandırılmış varsayılan ajanı kullanır.

Notlar:

- `models set <model-or-alias>`, `provider/model` veya bir takma ad kabul eder.
- Model başvuruları **ilk** `/` üzerinde bölünerek ayrıştırılır. Model kimliği `/` (OpenRouter tarzı) içeriyorsa, sağlayıcı önekini ekleyin (örnek: `openrouter/moonshotai/kimi-k2`).
- Sağlayıcıyı atladığınızda, OpenClaw girdiyi bir takma ad veya **varsayılan sağlayıcı** için bir model olarak ele alır (yalnızca model kimliğinde `/` yoksa çalışır).

### `models status`

Seçenekler:

- `--json`
- `--plain`
- `--check` (çıkış 1=süresi dolmuş/eksik, 2=süresi dolmak üzere)
- `--probe` (yapılandırılmış kimlik doğrulama profillerinin canlı yoklaması)
- `--probe-provider <name>` (tek bir sağlayıcıyı yokla)
- `--probe-profile <id>` (tekrarla veya virgülle ayrılmış profil kimlikleri)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (yapılandırılmış ajan kimliği; `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`’yi geçersiz kılar)

## Takma adlar + yedekler

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Kimlik doğrulama profilleri

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login`, bir sağlayıcı eklentisinin kimlik doğrulama akışını (OAuth/API anahtarı) çalıştırır. Yüklü sağlayıcıları görmek için
`openclaw plugins list` kullanın.

Notlar:

- `setup-token`, bir setup-token değeri ister (herhangi bir makinede `claude setup-token` ile oluşturun).
- `paste-token`, başka bir yerde veya otomasyondan üretilmiş bir belirteç dizgesini kabul eder.
