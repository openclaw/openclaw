---
summary: "gogcli aracılığıyla OpenClaw webhooks’larına bağlanan Gmail Pub/Sub push"
read_when:
  - Gmail gelen kutusu tetikleyicilerini OpenClaw’a bağlama
  - Ajan uyandırma için Pub/Sub push kurulumu
title: "Gmail Pub/Sub"
---

# Gmail Pub/Sub -> OpenClaw

Amaç: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> OpenClaw webhook.

## Önkoşullar

- `gcloud` kurulu ve oturum açılmış ([kurulum kılavuzu](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) kurulu ve Gmail hesabı için yetkilendirilmiş ([gogcli.sh](https://gogcli.sh/)).
- OpenClaw hooks etkin (bkz. [Webhooks](/automation/webhook)).
- `tailscale` ile oturum açılmış ([tailscale.com](https://tailscale.com/)). Desteklenen kurulum, herkese açık HTTPS uç noktası için Tailscale Funnel kullanır.
  Diğer tünel servisleri çalışabilir, ancak DIY/desteklenmez ve manuel kablolama gerektirir.
  Şu anda desteklediğimiz çözüm Tailscale’dir.

Örnek hook yapılandırması (Gmail ön ayar eşlemesini etkinleştirir):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

Gmail özetini bir sohbet yüzeyine iletmek için, `deliver` + isteğe bağlı `channel`/`to` ayarlayan bir eşleme ile ön ayarı geçersiz kılın:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

Sabit bir kanal istiyorsanız `channel` + `to` ayarlayın. Aksi halde `channel: "last"`
son teslim rotasını kullanır (WhatsApp’a geri düşer).

Gmail çalıştırmaları için daha ucuz bir modeli zorlamak üzere eşlemede `model` ayarlayın
(`provider/model` veya takma ad). `agents.defaults.models` dayatıyorsanız, bunu da buraya ekleyin.

Gmail hook’ları için varsayılan bir model ve düşünme seviyesi ayarlamak üzere yapılandırmanıza
`hooks.gmail.model` / `hooks.gmail.thinking` ekleyin:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

Notlar:

- Eşlemedeki hook başına `model`/`thinking` yine de bu varsayılanları geçersiz kılar.
- Geri dönüş sırası: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → birincil (kimlik doğrulama/hız sınırı/zaman aşımı).
- `agents.defaults.models` ayarlıysa, Gmail modeli izin listesinde olmalıdır.
- Gmail hook içeriği varsayılan olarak harici içerik güvenlik sınırlarıyla sarılır.
  Devre dışı bırakmak için (tehlikeli), `hooks.gmail.allowUnsafeExternalContent: true` ayarlayın.

Yükü daha fazla özelleştirmek için `hooks.mappings` ekleyin veya
`hooks.transformsDir` altında bir JS/TS dönüşüm modülü ekleyin (bkz. [Webhooks](/automation/webhook)).

## Sihirbaz (önerilir)

Her şeyi birlikte kablolamak için OpenClaw yardımcı aracını kullanın (macOS’ta bağımlılıkları brew ile kurar):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Varsayılanlar:

- Herkese açık push uç noktası için Tailscale Funnel kullanır.
- `openclaw webhooks gmail run` için `hooks.gmail` yapılandırmasını yazar.
- Gmail hook ön ayarını etkinleştirir (`hooks.presets: ["gmail"]`).

Yol notu: `tailscale.mode` etkinleştirildiğinde, OpenClaw otomatik olarak
`hooks.gmail.serve.path`’ü `/` olarak ayarlar ve herkese açık yolu
`hooks.gmail.tailscale.path`’da tutar (varsayılan `/gmail-pubsub`), çünkü Tailscale
proxy’lemeden önce set-path önekini kaldırır.
Arka ucun önekli yolu alması gerekiyorsa,
`hooks.gmail.tailscale.target` (veya `--tailscale-target`) değerini
`http://127.0.0.1:8788/gmail-pubsub` gibi tam bir URL olarak ayarlayın ve `hooks.gmail.serve.path` ile eşleştirin.

Özel bir uç nokta mı istiyorsunuz? `--push-endpoint <url>` veya `--tailscale off` kullanın.

Platform notu: macOS’ta sihirbaz `gcloud`, `gogcli` ve `tailscale`’yı
Homebrew üzerinden kurar; Linux’ta önce bunları manuel olarak kurun.

Gateway otomatik başlatma (önerilir):

- `hooks.enabled=true` ve `hooks.gmail.account` ayarlandığında, Gateway
  `gog gmail watch serve`’u açılışta başlatır ve watch’ı otomatik yeniler.
- Devre dışı bırakmak için `OPENCLAW_SKIP_GMAIL_WATCHER=1` ayarlayın (daemon’ı kendiniz çalıştırıyorsanız faydalıdır).
- Manuel daemon’ı aynı anda çalıştırmayın; aksi halde
  `listen tcp 127.0.0.1:8788: bind: address already in use` ile karşılaşırsınız.

Manuel daemon (`gog gmail watch serve` başlatır + otomatik yenileme):

```bash
openclaw webhooks gmail run
```

## Tek seferlik kurulum

1. `gog` tarafından kullanılan **OAuth istemcisinin sahibi** olan GCP projesini seçin.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Not: Gmail watch, Pub/Sub konusunun OAuth istemcisiyle aynı projede olmasını gerektirir.

2. API’leri etkinleştirin:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Bir konu oluşturun:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Gmail push’un yayımlamasına izin verin:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Watch’ı başlatın

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Çıktıdaki `history_id`’ü kaydedin (hata ayıklama için).

## Push işleyicisini çalıştırın

Yerel örnek (paylaşılan belirteç kimlik doğrulaması):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

Notlar:

- `--token`, push uç noktasını korur (`x-gog-token` veya `?token=`).
- `--hook-url`, OpenClaw `/hooks/gmail`’a işaret eder (eşlenmiş; izole çalıştırma + ana hatta özet).
- `--include-body` ve `--max-bytes`, OpenClaw’a gönderilen gövde parçasını kontrol eder.

Önerilir: `openclaw webhooks gmail run` aynı akışı sarar ve watch’ı otomatik yeniler.

## İşleyiciyi dışa açın (gelişmiş, desteklenmez)

Tailscale dışı bir tünele ihtiyacınız varsa, manuel olarak bağlayın ve push
aboneliğinde herkese açık URL’yi kullanın (desteklenmez, koruma yoktur):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Oluşturulan URL’yi push uç noktası olarak kullanın:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Üretim: kararlı bir HTTPS uç noktası kullanın ve Pub/Sub OIDC JWT’yi yapılandırın, ardından çalıştırın:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Test

İzlenen gelen kutusuna bir mesaj gönderin:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Watch durumunu ve geçmişi kontrol edin:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Sorun Giderme

- `Invalid topicName`: proje uyuşmazlığı (konu OAuth istemcisi projesinde değil).
- `User not authorized`: konuda `roles/pubsub.publisher` eksik.
- Boş mesajlar: Gmail push yalnızca `historyId` sağlar; `gog gmail history` üzerinden alın.

## Temizlik

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
