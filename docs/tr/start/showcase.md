---
title: "Vitrin"
description: "Real-world OpenClaw projects from the community"
summary: "OpenClaw tarafından desteklenen, topluluk tarafından geliştirilen projeler ve entegrasyonlar"
x-i18n:
  source_path: start/showcase.md
  source_hash: b3460f6a7b994879
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:17Z
---

# Vitrin

Topluluktan gerçek projeler. İnsanların OpenClaw ile neler inşa ettiğini görün.

<Info>
**Öne çıkarılmak ister misiniz?** Projenizi [Discord’da #showcase](https://discord.gg/clawd) kanalında paylaşın veya [X’te @openclaw’ı etiketleyin](https://x.com/openclaw).
</Info>

## 🎥 OpenClaw İş Başında

VelvetShark tarafından hazırlanan tam kurulum anlatımı (28 dk).

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/SaWSPZoPX34"
    title="OpenClaw: Siri’nin olması gereken self-hosted AI (Tam kurulum)"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[YouTube’da izle](https://www.youtube.com/watch?v=SaWSPZoPX34)

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/mMSKQvlmFuQ"
    title="OpenClaw vitrin videosu"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[YouTube’da izle](https://www.youtube.com/watch?v=mMSKQvlmFuQ)

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/5kkIJNUGFho"
    title="OpenClaw topluluk vitrini"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[YouTube’da izle](https://www.youtube.com/watch?v=5kkIJNUGFho)

## 🆕 Discord’dan Taze

<CardGroup cols={2}>

<Card title="PR İncelemesi → Telegram Geri Bildirimi" icon="code-pull-request" href="https://x.com/i/status/2010878524543131691">
  **@bangnokia** • `review` `github` `telegram`

OpenCode değişikliği tamamlar → bir PR açar → OpenClaw diff’i inceler ve Telegram’da “küçük öneriler” ile birlikte net bir birleştirme kararıyla yanıtlar (önce uygulanması gereken kritik düzeltmeler dâhil).

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="OpenClaw PR inceleme geri bildiriminin Telegram’da iletilmesi" />
</Card>

<Card title="Dakikalar İçinde Şarap Mahzeni Skill’i" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  **@prades_maxime** • `skills` `local` `csv`

“Robby”den (@openclaw) yerel bir şarap mahzeni skill’i istendi. Örnek bir CSV dışa aktarımı ve nereye kaydedileceğini soruyor; ardından skill’i hızla oluşturup test ediyor (örnekte 962 şişe).

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="OpenClaw’ın CSV’den yerel bir şarap mahzeni skill’i oluşturması" />
</Card>

<Card title="Tesco Alışveriş Otopilotu" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  **@marchattonhere** • `automation` `browser` `shopping`

Haftalık yemek planı → düzenli ürünler → teslimat zamanını ayırt → siparişi onayla. API yok, yalnızca tarayıcı kontrolü.

  <img src="/assets/showcase/tesco-shop.jpg" alt="Sohbet üzerinden Tesco alışveriş otomasyonu" />
</Card>

<Card title="SNAG Ekran Görüntüsünden Markdown’a" icon="scissors" href="https://github.com/am-will/snag">
  **@am-will** • `devtools` `screenshots` `markdown`

Ekranın bir bölgesini kısayolla seç → Gemini vision → panoya anında Markdown.

  <img src="/assets/showcase/snag.png" alt="SNAG ekran görüntüsünden markdown aracı" />
</Card>

<Card title="Agents UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  **@kitze** • `ui` `skills` `sync`

Agents, Claude, Codex ve OpenClaw genelinde skills/komutları yönetmek için masaüstü uygulaması.

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI uygulaması" />
</Card>

<Card title="Telegram Sesli Notlar (papla.media)" icon="microphone" href="https://papla.media/docs">
  **Topluluk** • `voice` `tts` `telegram`

papla.media TTS’i sarar ve sonuçları Telegram sesli notları olarak gönderir (rahatsız edici otomatik oynatma yok).

  <img src="/assets/showcase/papla-tts.jpg" alt="TTS’ten Telegram sesli not çıktısı" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.com/odrobnik/codexmonitor">
  **@odrobnik** • `devtools` `codex` `brew`

Yerel OpenAI Codex oturumlarını listelemek/incelemek/izlemek için Homebrew ile kurulan yardımcı (CLI + VS Code).

  <img src="/assets/showcase/codexmonitor.png" alt="ClawHub’da CodexMonitor" />
</Card>

<Card title="Bambu 3D Yazıcı Kontrolü" icon="print" href="https://clawhub.com/tobiasbischoff/bambu-cli">
  **@tobiasbischoff** • `hardware` `3d-printing` `skill`

BambuLab yazıcılarını kontrol etme ve sorun giderme: durum, işler, kamera, AMS, kalibrasyon ve daha fazlası.

  <img src="/assets/showcase/bambu-cli.png" alt="ClawHub’da Bambu CLI skill’i" />
</Card>

<Card title="Viyana Ulaşımı (Wiener Linien)" icon="train" href="https://clawhub.com/hjanuschka/wienerlinien">
  **@hjanuschka** • `travel` `transport` `skill`

Viyana toplu taşıması için gerçek zamanlı kalkışlar, aksamalar, asansör durumu ve yönlendirme.

  <img src="/assets/showcase/wienerlinien.png" alt="ClawHub’da Wiener Linien skill’i" />
</Card>

<Card title="ParentPay Okul Yemekleri" icon="utensils" href="#">
  **@George5562** • `automation` `browser` `parenting`

ParentPay üzerinden Birleşik Krallık okul yemeği rezervasyonunun otomasyonu. Güvenilir tablo hücresi tıklaması için fare koordinatlarını kullanır.
</Card>

<Card title="R2 Yükleme (Dosyalarımı Bana Gönder)" icon="cloud-arrow-up" href="https://clawhub.com/skills/r2-upload">
  **@julianengel** • `files` `r2` `presigned-urls`

Cloudflare R2/S3’e yükleme ve güvenli, önceden imzalanmış indirme bağlantıları oluşturma. Uzaktaki OpenClaw örnekleri için mükemmel.
</Card>

<Card title="Telegram Üzerinden iOS Uygulaması" icon="mobile" href="#">
  **@coard** • `ios` `xcode` `testflight`

Haritalar ve ses kaydı içeren eksiksiz bir iOS uygulaması geliştirildi; tamamen Telegram sohbeti üzerinden TestFlight’a dağıtıldı.

  <img src="/assets/showcase/ios-testflight.jpg" alt="TestFlight’ta iOS uygulaması" />
</Card>

<Card title="Oura Ring Sağlık Asistanı" icon="heart-pulse" href="#">
  **@AS** • `health` `oura` `calendar`

Oura ring verilerini takvim, randevular ve spor salonu programıyla entegre eden kişisel AI sağlık asistanı.

  <img src="/assets/showcase/oura-health.png" alt="Oura ring sağlık asistanı" />
</Card>
<Card title="Kev’in Rüya Takımı (14+ Ajan)" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  **@adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

Tek bir gateway altında 14+ ajan; Codex çalışanlarına delege eden Opus 4.5 orkestratörü. Dream Team kadrosu, model seçimi, sandboxing, webhooks, kalp atışları ve delegasyon akışlarını kapsayan kapsamlı [teknik yazı](https://github.com/adam91holt/orchestrated-ai-articles). Ajan sandboxing’i için [Clawdspace](https://github.com/adam91holt/clawdspace). [Blog yazısı](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/).
</Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  **@NessZerra** • `devtools` `linear` `cli` `issues`

Agentik iş akışlarıyla (Claude Code, OpenClaw) entegre Linear için CLI. Terminalden issue’ları, projeleri ve iş akışlarını yönetin. İlk harici PR birleştirildi!
</Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  **@jules** • `messaging` `beeper` `cli` `automation`

Beeper Desktop üzerinden mesajları okuma, gönderme ve arşivleme. Beeper local MCP API’yi kullanır; böylece ajanlar tüm sohbetlerinizi (iMessage, WhatsApp vb.) tek yerde yönetebilir.
</Card>

</CardGroup>

## 🤖 Otomasyon ve İş Akışları

<CardGroup cols={2}>

<Card title="Winix Hava Temizleyici Kontrolü" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  **@antonplex** • `automation` `hardware` `air-quality`

Claude Code, temizleyici kontrollerini keşfedip doğruladı; ardından OpenClaw oda hava kalitesini yönetmek için devralıyor.

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="OpenClaw üzerinden Winix hava temizleyici kontrolü" />
</Card>

<Card title="Güzel Gökyüzü Kamera Kareleri" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  **@signalgaining** • `automation` `camera` `skill` `images`

Bir çatı kamerası tarafından tetiklenir: gökyüzü güzel göründüğünde OpenClaw’dan fotoğraf çekmesini iste — bir skill tasarladı ve çekimi yaptı.

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="OpenClaw tarafından yakalanan çatı kamerası gökyüzü anlık görüntüsü" />
</Card>

<Card title="Görsel Sabah Brifingi Sahnesi" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  **@buddyhadry** • `automation` `briefing` `images` `telegram`

Zamanlanmış bir istem, OpenClaw personası aracılığıyla her sabah tek bir “sahne” görseli üretir (hava durumu, görevler, tarih, favori gönderi/alıntı).
</Card>

<Card title="Padel Kort Rezervasyonu" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  **@joshp123** • `automation` `booking` `cli`
  
  Playtomic uygunluk denetleyicisi + rezervasyon CLI’si. Bir daha açık kortu kaçırmayın.
  
  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli ekran görüntüsü" />
</Card>

<Card title="Muhasebe Alımı" icon="file-invoice-dollar">
  **Topluluk** • `automation` `email` `pdf`
  
  E-postadan PDF’leri toplar, belgeleri mali müşavir için hazırlar. Aylık muhasebe otopilotta.
</Card>

<Card title="Koltuk Patatesi Geliştirici Modu" icon="couch" href="https://davekiss.com">
  **@davekiss** • `telegram` `website` `migration` `astro`

Netflix izlerken Telegram üzerinden tüm kişisel siteyi yeniden inşa etti — Notion → Astro, 18 gönderi taşındı, DNS Cloudflare’a. Hiç laptop açmadı.
</Card>

<Card title="İş Arama Ajanı" icon="briefcase">
  **@attol8** • `automation` `api` `skill`

İş ilanlarını arar, CV anahtar kelimeleriyle eşleştirir ve ilgili fırsatları bağlantılarıyla döndürür. JSearch API kullanılarak 30 dakikada geliştirildi.
</Card>

<Card title="Jira Skill Oluşturucu" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  **@jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw Jira’ya bağlandı ve anında yeni bir skill oluşturdu (ClawHub’da var olmadan önce).
</Card>

<Card title="Telegram Üzerinden Todoist Skill’i" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  **@iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

Todoist görevlerini otomatikleştirdi ve OpenClaw’ın skill’i doğrudan Telegram sohbetinde üretmesini sağladı.
</Card>

<Card title="TradingView Analizi" icon="chart-line">
  **@bheem1798** • `finance` `browser` `automation`

Tarayıcı otomasyonu ile TradingView’e giriş yapar, grafiklerin ekran görüntüsünü alır ve isteğe bağlı teknik analiz yapar. API gerekmez—yalnızca tarayıcı kontrolü.
</Card>

<Card title="Slack Otomatik Destek" icon="slack">
  **@henrymascot** • `slack` `automation` `support`

Şirket Slack kanalını izler, faydalı yanıtlar verir ve bildirimleri Telegram’a iletir. Sorulmadan, dağıtılmış bir uygulamada üretim hatasını otonom olarak düzeltti.
</Card>

</CardGroup>

## 🧠 Bilgi ve Bellek

<CardGroup cols={2}>

<Card title="xuezh Çince Öğrenme" icon="language" href="https://github.com/joshp123/xuezh">
  **@joshp123** • `learning` `voice` `skill`
  
  OpenClaw üzerinden telaffuz geri bildirimi ve çalışma akışları sunan Çince öğrenme motoru.
  
  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh telaffuz geri bildirimi" />
</Card>

<Card title="WhatsApp Bellek Kasası" icon="vault">
  **Topluluk** • `memory` `transcription` `indexing`
  
  Tam WhatsApp dışa aktarımlarını alır, 1k+ sesli notu deşifre eder, git günlükleriyle çapraz kontrol eder ve bağlantılı markdown raporları üretir.
</Card>

<Card title="Karakeep Anlamsal Arama" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  **@jamesbrooksco** • `search` `vector` `bookmarks`
  
  Qdrant + OpenAI/Ollama embedding’leri kullanarak Karakeep yer imlerine vektör arama ekler.
</Card>

<Card title="Inside-Out-2 Bellek" icon="brain">
  **Topluluk** • `memory` `beliefs` `self-model`
  
  Oturum dosyalarını bellek → inanç → evrilen benlik modeline dönüştüren ayrı bir bellek yöneticisi.
</Card>

</CardGroup>

## 🎙️ Ses ve Telefon

<CardGroup cols={2}>

<Card title="Clawdia Telefon Köprüsü" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  **@alejandroOPI** • `voice` `vapi` `bridge`
  
  Vapi sesli asistan ↔ OpenClaw HTTP köprüsü. Ajanınızla neredeyse gerçek zamanlı telefon görüşmeleri.
</Card>

<Card title="OpenRouter Deşifre" icon="microphone" href="https://clawhub.com/obviyus/openrouter-transcribe">
  **@obviyus** • `transcription` `multilingual` `skill`

OpenRouter (Gemini vb.) üzerinden çok dilli ses deşifresi. ClawHub’da mevcut.
</Card>

</CardGroup>

## 🏗️ Altyapı ve Dağıtım

<CardGroup cols={2}>

<Card title="Home Assistant Eklentisi" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  **@ngutman** • `homeassistant` `docker` `raspberry-pi`
  
  SSH tüneli desteği ve kalıcı durum ile Home Assistant OS üzerinde çalışan OpenClaw gateway.
</Card>

<Card title="Home Assistant Skill’i" icon="toggle-on" href="https://clawhub.com/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`
  
  Doğal dil üzerinden Home Assistant cihazlarını kontrol edin ve otomatikleştirin.
</Card>

<Card title="Nix Paketleme" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  **@openclaw** • `nix` `packaging` `deployment`
  
  Tekrarlanabilir dağıtımlar için piller dâhil nix’lenmiş OpenClaw yapılandırması.
</Card>

<Card title="CalDAV Takvimi" icon="calendar" href="https://clawhub.com/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`
  
  khal/vdirsyncer kullanan takvim skill’i. Self-hosted takvim entegrasyonu.
</Card>

</CardGroup>

## 🏠 Ev ve Donanım

<CardGroup cols={2}>

<Card title="GoHome Otomasyonu" icon="house-signal" href="https://github.com/joshp123/gohome">
  **@joshp123** • `home` `nix` `grafana`
  
  Arayüz olarak OpenClaw kullanan Nix-native ev otomasyonu ve şık Grafana panoları.
  
  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana panosu" />
</Card>

<Card title="Roborock Süpürge" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  **@joshp123** • `vacuum` `iot` `plugin`
  
  Doğal sohbet üzerinden Roborock robot süpürgenizi kontrol edin.
  
  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock durumu" />
</Card>

</CardGroup>

## 🌟 Topluluk Projeleri

<CardGroup cols={2}>

<Card title="StarSwap Pazaryeri" icon="star" href="https://star-swap.com/">
  **Topluluk** • `marketplace` `astronomy` `webapp`
  
  Tam kapsamlı bir astronomi ekipmanı pazaryeri. OpenClaw ekosistemiyle/etrafında inşa edilmiştir.
</Card>

</CardGroup>

---

## Projenizi Gönderin

Paylaşacak bir şeyiniz mi var? Öne çıkarmaktan memnuniyet duyarız!

<Steps>
  <Step title="Paylaşın">
    [Discord’da #showcase](https://discord.gg/clawd) kanalında paylaşın veya [@openclaw’ı tweetleyin](https://x.com/openclaw)
  </Step>
  <Step title="Ayrıntıları Ekleyin">
    Ne yaptığını anlatın, repo/demo bağlantısını ekleyin, varsa bir ekran görüntüsü paylaşın
  </Step>
  <Step title="Öne Çıkarılın">
    Dikkat çeken projeleri bu sayfaya ekleyeceğiz
  </Step>
</Steps>
