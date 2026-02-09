---
summary: "Tlon/Urbit destek durumu, yetenekler ve yapılandırma"
read_when:
  - Tlon/Urbit kanal özellikleri üzerinde çalışırken
title: "Tlon"
---

# Tlon (eklenti)

Tlon, Urbit üzerinde inşa edilmiş merkeziyetsiz bir mesajlaşma uygulamasıdır. OpenClaw, Urbit geminize bağlanır ve
DM'lere ve grup sohbeti mesajlarına yanıt verebilir. Grup yanıtları varsayılan olarak bir @ bahsetmesi gerektirir ve
izin listeleri aracılığıyla daha da kısıtlanabilir.

Durum: eklenti aracılığıyla desteklenir. DM'ler, grup bahsetmeleri, konu (thread) yanıtları ve yalnızca metin medya geri dönüşü
(URL başlığa eklenir) desteklenir. Tepkiler, anketler ve yerel medya yüklemeleri desteklenmez.

## Eklenti gerekli

Tlon bir eklenti olarak sunulur ve çekirdek kurulumla birlikte gelmez.

CLI üzerinden kurulum (npm kayıt defteri):

```bash
openclaw plugins install @openclaw/tlon
```

Yerel checkout (bir git deposundan çalıştırırken):

```bash
openclaw plugins install ./extensions/tlon
```

Ayrıntılar: [Plugins](/tools/plugin)

## Kurulum

1. Tlon eklentisini kurun.
2. Gemi URL’nizi ve giriş kodunuzu toplayın.
3. `channels.tlon` yapılandırmasını yapın.
4. gateway’i yeniden başlatın.
5. Bot’a DM gönderin veya bir grup kanalında ondan bahsedin.

Asgari yapılandırma (tek hesap):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Grup kanalları

Otomatik keşif varsayılan olarak etkindir. Kanalları manuel olarak da sabitleyebilirsiniz:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Otomatik keşfi devre dışı bırakma:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Erişim denetimi

DM izin listesi (boş = tümüne izin ver):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Grup yetkilendirmesi (varsayılan olarak kısıtlı):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Teslim hedefleri (CLI/cron)

Bunları `openclaw message send` veya cron teslimi ile kullanın:

- DM: `~sampel-palnet` veya `dm/~sampel-palnet`
- Grup: `chat/~host-ship/channel` veya `group:~host-ship/channel`

## Notlar

- Grup yanıtları, yanıt vermek için bir bahsetme gerektirir (ör. `~your-bot-ship`).
- Konu (thread) yanıtları: gelen mesaj bir konu içindeyse, OpenClaw konu içinde yanıtlar.
- Medya: `sendMedia` metin + URL’ye geri döner (yerel yükleme yok).
