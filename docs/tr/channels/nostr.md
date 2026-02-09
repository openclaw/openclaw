---
summary: "NIP-04 şifreli mesajlar üzerinden Nostr DM kanalı"
read_when:
  - OpenClaw’ın Nostr üzerinden DM almasını istiyorsunuz
  - Merkeziyetsiz mesajlaşma kuruyorsunuz
title: "Nostr"
---

# Nostr

**Durum:** İsteğe bağlı eklenti (varsayılan olarak devre dışı).

Nostr, sosyal ağlar için merkeziyetsiz bir protokoldür. Bu kanal, OpenClaw’ın NIP-04 üzerinden şifreli doğrudan mesajlar (DM) almasını ve yanıtlamasını sağlar.

## Yükleme (isteğe bağlı)

### Onboarding (önerilen)

- Onboarding sihirbazı (`openclaw onboard`) ve `openclaw channels add` isteğe bağlı kanal eklentilerini listeler.
- Nostr’u seçtiğinizde eklentiyi isteğe bağlı olarak yüklemeniz istenir.

Yükleme varsayılanları:

- **Dev kanalı + git checkout mevcut:** yerel eklenti yolu kullanılır.
- **Stable/Beta:** npm’den indirilir.

İstediğiniz zaman istemdeki seçimi geçersiz kılabilirsiniz.

### Manuel yükleme

```bash
openclaw plugins install @openclaw/nostr
```

Yerel checkout kullanın (dev iş akışları):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Eklentileri yükledikten veya etkinleştirdikten sonra Gateway’i yeniden başlatın.

## Hızlı kurulum

1. Bir Nostr anahtar çifti oluşturun (gerekiyorsa):

```bash
# Using nak
nak key generate
```

2. Yapılandırmaya ekleyin:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Anahtarı dışa aktarın:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Gateway’i yeniden başlatın.

## Yapılandırma referansı

| Anahtar      | Type                                                         | Varsayılan                                  | Açıklama                                      |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------- |
| `privateKey` | string                                                       | gerekli                                     | `nsec` veya hex formatında özel anahtar       |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay URL’leri (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | DM erişim politikası                          |
| `allowFrom`  | string[] | `[]`                                        | İzin verilen gönderen pubkey’leri             |
| `enabled`    | boolean                                                      | `true`                                      | Kanalı etkinleştir/devre dışı bırak           |
| `name`       | string                                                       | -                                           | Display name                                  |
| `profile`    | object                                                       | -                                           | NIP-01 profil meta verileri                   |

## Profil meta verileri

Profil verileri bir NIP-01 `kind:0` olayı olarak yayımlanır. Control UI’den (Kanallar -> Nostr -> Profil) yönetebilir veya doğrudan yapılandırmada ayarlayabilirsiniz.

Örnek:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

Notlar:

- Profil URL’leri `https://` kullanmalıdır.
- Relay’lerden içe aktarma alanları birleştirir ve yerel geçersiz kılmaları korur.

## Erişim denetimi

### DM politikaları

- **pairing** (varsayılan): bilinmeyen gönderenler bir eşleştirme kodu alır.
- **allowlist**: yalnızca `allowFrom` içindeki pubkey’ler DM gönderebilir.
- **open**: herkese açık gelen DM’ler (`allowFrom: ["*"]` gerektirir).
- **disabled**: gelen DM’leri yok sayar.

### Allowlist örneği

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Anahtar formatları

Kabul edilen formatlar:

- **Özel anahtar:** `nsec...` veya 64 karakterli hex
- **Pubkey’ler (`allowFrom`):** `npub...` veya hex

## Relay’ler

Varsayılanlar: `relay.damus.io` ve `nos.lol`.

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

İpuçları:

- Yedeklilik için 2-3 relay kullanın.
- Çok fazla relay’den kaçının (gecikme, çoğaltma).
- Ücretli relay’ler güvenilirliği artırabilir.
- Yerel relay’ler test için uygundur (`ws://localhost:7777`).

## Protokol desteği

| NIP    | Status        | Açıklama                                     |
| ------ | ------------- | -------------------------------------------- |
| NIP-01 | Destekleniyor | Temel olay formatı + profil meta verileri    |
| NIP-04 | Destekleniyor | Şifreli DM’ler (`kind:4`) |
| NIP-17 | Planlanıyor   | Hediye sarmalı DM’ler                        |
| NIP-44 | Planlanıyor   | Versioned encryption                         |

## Test

### Yerel relay

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Manuel test

1. Günlüklerden bot pubkey’ini (npub) not edin.
2. Bir Nostr istemcisi açın (Damus, Amethyst vb.).
3. Bot pubkey’ine DM gönderin.
4. Verify the response.

## Sorun Giderme

### Mesajlar alınmıyor

- Özel anahtarın geçerli olduğunu doğrulayın.
- Relay URL’lerinin erişilebilir olduğundan ve `wss://` kullandığından emin olun (yerel için `ws://`).
- `enabled`’nin `false` olmadığını doğrulayın.
- Relay bağlantı hataları için Gateway günlüklerini kontrol edin.

### Yanıtlar gönderilmiyor

- Relay’in yazmaları kabul ettiğini kontrol edin.
- Giden bağlantıyı doğrulayın.
- Relay hız limitlerine dikkat edin.

### Yinelenen yanıtlar

- Birden fazla relay kullanıldığında beklenir.
- Mesajlar olay kimliğine göre tekilleştirilir; yalnızca ilk teslimat bir yanıt tetikler.

## Güvenlik

- Özel anahtarları asla commit etmeyin.
- Anahtarlar için ortam değişkenlerini kullanın.
- Üretim botları için `allowlist`’u değerlendirin.

## Sınırlamalar (MVP)

- Yalnızca doğrudan mesajlar (grup sohbetleri yok).
- Medya ekleri yok.
- Yalnızca NIP-04 (NIP-17 hediye sarmalı planlanıyor).
