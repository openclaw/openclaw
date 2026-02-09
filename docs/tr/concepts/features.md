---
summary: "Kanallar, yönlendirme, medya ve UX genelinde OpenClaw yetenekleri."
read_when:
  - OpenClaw’ın neleri desteklediğine dair tam bir liste istiyorsanız
title: "Özellikler"
---

## Öne çıkanlar

<Columns>
  <Card title="Channels" icon="message-square">
    Tek bir Gateway ile WhatsApp, Telegram, Discord ve iMessage.
  </Card>
  <Card title="Plugins" icon="plug">
    Uzantılarla Mattermost ve daha fazlasını ekleyin.
  </Card>
  <Card title="Routing" icon="route">
    İzole oturumlarla çoklu ajan yönlendirmesi.
  </Card>
  <Card title="Media" icon="image">
    Görseller, ses ve belgeler; giriş ve çıkış.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    Web Control UI ve macOS yardımcı uygulaması.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    Canvas desteğiyle iOS ve Android düğümleri.
  </Card>
</Columns>

## Tam liste

- WhatsApp Web (Baileys) üzerinden WhatsApp entegrasyonu
- Telegram bot desteği (grammY)
- Discord bot desteği (channels.discord.js)
- Mattermost bot desteği (eklenti)
- local imsg CLI (macOS) üzerinden iMessage entegrasyonu
- Araç akışıyla RPC modunda Pi için ajan köprüsü
- Uzun yanıtlar için akış ve parçalara bölme
- Çalışma alanı veya gönderici başına izole oturumlar için çoklu ajan yönlendirmesi
- OAuth üzerinden Anthropic ve OpenAI için abonelik kimlik doğrulaması
- Oturumlar: doğrudan sohbetler paylaşılan `main` içinde toplanır; gruplar izoledir
- Bahsetmeye dayalı etkinleştirme ile grup sohbeti desteği
- Görseller, ses ve belgeler için medya desteği
- İsteğe bağlı sesli not döküm kancası
- WebChat ve macOS menü çubuğu uygulaması
- Eşleştirme ve Canvas yüzeyiyle iOS düğümü
- Eşleştirme, Canvas, sohbet ve kamera ile Android düğümü

<Note>
Legacy Claude, Codex, Gemini ve Opencode yolları kaldırılmıştır. Pi, tek
kodlama ajanı yoludur.
</Note>
