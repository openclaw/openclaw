---
summary: "zca-cli (QR oturum açma) üzerinden Zalo kişisel hesap desteği, yetenekler ve yapılandırma"
read_when:
  - OpenClaw için Zalo Personal kurulumu
  - Zalo Personal oturum açma veya mesaj akışı sorunlarını giderme
title: "Zalo Personal"
---

# Zalo Personal (resmi olmayan)

Durum: deneysel. Bu entegrasyon, `zca-cli` aracılığıyla **kişisel bir Zalo hesabını** otomatikleştirir.

> **Uyarı:** Bu resmi olmayan bir entegrasyondur ve hesabın askıya alınmasına/engellenmesine yol açabilir. Kullanım riski size aittir.

## Gerekli eklenti

Zalo Personal bir eklenti olarak sunulur ve çekirdek kurulumla birlikte gelmez.

- CLI ile yükleme: `openclaw plugins install @openclaw/zalouser`
- Veya kaynak kodundan: `openclaw plugins install ./extensions/zalouser`
- Ayrıntılar: [Plugins](/tools/plugin)

## Ön koşul: zca-cli

Gateway ana makinesinde `zca` ikili dosyasının `PATH` içinde mevcut olması gerekir.

- Doğrulama: `zca --version`
- Eksikse, zca-cli’yi yükleyin (`extensions/zalouser/README.md` veya upstream zca-cli belgelerine bakın).

## Hızlı kurulum (başlangıç)

1. Eklentiyi yükleyin (yukarıya bakın).
2. Oturum açın (QR, Gateway ana makinesinde):
   - `openclaw channels login --channel zalouser`
   - Terminaldeki QR kodunu Zalo mobil uygulamasıyla tarayın.
3. Kanalı etkinleştirin:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Gateway’i yeniden başlatın (veya ilk kurulumu tamamlayın).
5. DM erişimi varsayılan olarak eşleştirmeye ayarlıdır; ilk iletişimde eşleştirme kodunu onaylayın.

## Nedir

- Gelen mesajları almak için `zca listen` kullanır.
- Yanıt göndermek için `zca msg ...` kullanır (metin/medya/bağlantı).
- Zalo Bot API’nin mevcut olmadığı “kişisel hesap” kullanım senaryoları için tasarlanmıştır.

## Naming

Kanal kimliği `zalouser`’tür; bunun **kişisel bir Zalo kullanıcı hesabını** (resmi olmayan) otomatikleştirdiğini açıkça belirtir. Olası gelecekteki resmi Zalo API entegrasyonu için `zalo` ayrılmıştır.

## Kimlikleri bulma (dizin)

Eşleri/grupları ve kimliklerini keşfetmek için dizin CLI’sini kullanın:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Sınırlamalar

- Giden metin ~2000 karakterlik parçalara bölünür (Zalo istemci sınırları).
- Akış varsayılan olarak engellenir.

## Erişim denetimi (DM’ler)

`channels.zalouser.dmPolicy` şunları destekler: `pairing | allowlist | open | disabled` (varsayılan: `pairing`).
`channels.zalouser.allowFrom` kullanıcı kimliklerini veya adlarını kabul eder. Sihirbaz, mümkün olduğunda adları `zca friend find` aracılığıyla kimliklere çözümler.

Onaylama:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Grup erişimi (isteğe bağlı)

- Varsayılan: `channels.zalouser.groupPolicy = "open"` (gruplara izin verilir). Ayarlanmadığında varsayılanı geçersiz kılmak için `channels.defaults.groupPolicy` kullanın.
- Bir izin listesiyle sınırlandırın:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (anahtarlar grup kimlikleri veya adlarıdır)
- Tüm grupları engelleyin: `channels.zalouser.groupPolicy = "disabled"`.
- Yapılandırma sihirbazı grup izin listeleri için sorular sorabilir.
- Başlangıçta OpenClaw, izin listelerindeki grup/kullanıcı adlarını kimliklere çözümler ve eşlemeyi günlüğe kaydeder; çözülemeyen girdiler yazıldığı gibi tutulur.

Örnek:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Çoklu hesap

Hesaplar zca profilleriyle eşleştirilir. Örnek:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Sorun Giderme

**`zca` bulunamadı:**

- zca-cli’yi yükleyin ve Gateway süreci için `PATH` üzerinde olduğundan emin olun.

**Login doesn’t stick:**

- `openclaw channels status --probe`
- Yeniden oturum açın: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
