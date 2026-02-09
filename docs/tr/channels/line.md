---
summary: "LINE Messaging API eklenti kurulumu, yapılandırması ve kullanımı"
read_when:
  - OpenClaw’ı LINE’a bağlamak istiyorsunuz
  - LINE webhook + kimlik bilgisi kurulumuna ihtiyacınız var
  - LINE’a özgü mesaj seçeneklerini istiyorsunuz
title: LINE
---

# LINE (eklenti)

LINE, LINE Messaging API üzerinden OpenClaw’a bağlanır. Eklenti, Gateway üzerinde bir webhook
alıcı olarak çalışır ve kimlik doğrulama için kanal erişim belirtecinizi + kanal gizlinizi
kullanır.

Durum: eklenti aracılığıyla desteklenir. Doğrudan mesajlar, grup sohbetleri, medya, konumlar, Flex
mesajları, şablon mesajlar ve hızlı yanıtlar desteklenir. Tepkiler ve konu başlıkları desteklenmez.

## Gerekli eklenti

LINE eklentisini yükleyin:

```bash
openclaw plugins install @openclaw/line
```

Yerel checkout (bir git deposundan çalıştırırken):

```bash
openclaw plugins install ./extensions/line
```

## Kurulum

1. Bir LINE Developers hesabı oluşturun ve Konsolu açın:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Bir Sağlayıcı oluşturun (veya seçin) ve bir **Messaging API** kanalı ekleyin.
3. Kanal ayarlarından **Channel access token** ve **Channel secret** değerlerini kopyalayın.
4. Messaging API ayarlarında **Use webhook** seçeneğini etkinleştirin.
5. Webhook URL’sini gateway uç noktanıza ayarlayın (HTTPS gereklidir):

```
https://gateway-host/line/webhook
```

Gateway, LINE’ın webhook doğrulamasına (GET) ve gelen olaylara (POST) yanıt verir.
Özel bir yol gerekiyorsa `channels.line.webhookPath` veya
`channels.line.accounts.<id>.webhookPath` ayarlayın ve URL’yi buna göre güncelleyin.

## Yapılandırma

Asgari yapılandırma:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Env vars (default account only):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Belirteç/gizli dosyaları:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

Birden fazla hesap:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Erişim denetimi

Doğrudan mesajlar varsayılan olarak eşleştirmeye tabidir. Bilinmeyen gönderenlere bir
eşleştirme kodu verilir ve onaylanana kadar mesajları yok sayılır.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

İzin listeleri ve politikalar:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: DM’ler için izin listesine alınmış LINE kullanıcı kimlikleri
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: gruplar için izin listesine alınmış LINE kullanıcı kimlikleri
- Grup başına geçersiz kılmalar: `channels.line.groups.<groupId>.allowFrom`

LINE kimlikleri büyük/küçük harfe duyarlıdır. Geçerli kimlikler şu şekildedir:

- Kullanıcı: `U` + 32 hex karakter
- Grup: `C` + 32 hex karakter
- Oda: `R` + 32 hex karakter

## Mesaj davranışı

- Metin 5000 karakterde parçalara bölünür.
- Markdown biçimlendirmesi kaldırılır; mümkün olduğunda kod blokları ve tablolar Flex
  kartlarına dönüştürülür.
- Akışlı yanıtlar arabelleğe alınır; ajan çalışırken LINE tam parçaları bir yükleme
  animasyonu ile alır.
- Medya indirmeleri `channels.line.mediaMaxMb` ile sınırlandırılır (varsayılan 10).

## Kanal verileri (zengin mesajlar)

Hızlı yanıtlar, konumlar, Flex kartları veya şablon
mesajlar göndermek için `channelData.line` kullanın.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

LINE eklentisi ayrıca Flex mesaj ön ayarları için bir `/card` komutu da içerir:

```
/card info "Welcome" "Thanks for joining!"
```

## Sorun Giderme

- **Webhook doğrulaması başarısız:** webhook URL’sinin HTTPS olduğundan ve
  `channelSecret` değerinin LINE konsoluyla eşleştiğinden emin olun.
- **Gelen olay yok:** webhook yolunun `channels.line.webhookPath` ile eşleştiğini
  ve gateway’in LINE tarafından erişilebilir olduğunu doğrulayın.
- **Medya indirme hataları:** medya varsayılan sınırı aşıyorsa `channels.line.mediaMaxMb` değerini artırın.
