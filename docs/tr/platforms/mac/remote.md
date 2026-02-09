---
summary: "SSH üzerinden uzak bir OpenClaw gateway’ini kontrol etmek için macOS uygulama akışı"
read_when:
  - Uzaktan Mac kontrolünü kurma veya hata ayıklama
title: "Uzaktan Denetim"
---

# Uzak OpenClaw (macOS ⇄ uzak ana makine)

Bu akış, macOS uygulamasının başka bir ana makinede (masaüstü/sunucu) çalışan bir OpenClaw gateway’i için tam teşekküllü bir uzaktan kumanda olarak çalışmasını sağlar. Bu, uygulamanın **SSH üzerinden uzaktan bağlantı** (remote run) özelliğidir. Tüm özellikler—sağlık kontrolleri, Voice Wake yönlendirme ve Web Chat—_Ayarlar → Genel_ bölümündeki aynı uzak SSH yapılandırmasını yeniden kullanır.

## Modlar

- **Yerel (bu Mac)**: Her şey dizüstünde çalışır. SSH yoktur.
- **SSH üzerinden uzaktan (varsayılan)**: OpenClaw komutları uzak ana makinede yürütülür. macOS uygulaması, `-o BatchMode` ile birlikte seçtiğiniz kimlik/anahtar ve bir yerel port yönlendirmesi kullanarak bir SSH bağlantısı açar.
- **Doğrudan uzaktan (ws/wss)**: SSH tüneli yoktur. macOS uygulaması gateway URL’sine doğrudan bağlanır (örneğin Tailscale Serve veya herkese açık bir HTTPS ters proxy üzerinden).

## Uzak taşıma yöntemleri

Uzak mod iki taşıma yöntemini destekler:

- **SSH tüneli** (varsayılan): Gateway portunu localhost’a yönlendirmek için `ssh -N -L ...` kullanır. Tünel local loopback olduğu için gateway, düğüm IP’sini `127.0.0.1` olarak görür.
- **Doğrudan (ws/wss)**: Gateway URL’sine doğrudan bağlanır. Gateway gerçek istemci IP’sini görür.

## Uzak ana bilgisayardaki ön koşullar

1. Node + pnpm’i kurun ve OpenClaw CLI’yi derleyip/yükleyin (`pnpm install && pnpm build && pnpm link --global`).
2. Etkileşimsiz kabuklar için `openclaw`’in PATH üzerinde olduğundan emin olun (gerekirse `/usr/local/bin` veya `/opt/homebrew/bin` içine sembolik bağlantı oluşturun).
3. Anahtar tabanlı kimlik doğrulama ile SSH’ı açın. LAN dışı stabil erişim için **Tailscale** IP’lerini öneririz.

## macOS uygulama kurulumu

1. _Ayarlar → Genel_ bölümünü açın.
2. **OpenClaw runs** altında **SSH üzerinden uzaktan**’ı seçin ve şunları ayarlayın:
   - **Transport**: **SSH tüneli** veya **Doğrudan (ws/wss)**.
   - **SSH target**: `user@host` (isteğe bağlı `:port`).
     - Gateway aynı LAN üzerindeyse ve Bonjour yayımlıyorsa, alanı otomatik doldurmak için keşfedilen listeden seçin.
   - **Gateway URL** (yalnızca Doğrudan): `wss://gateway.example.ts.net` (yerel/LAN için `ws://...`).
   - **Identity file** (gelişmiş): anahtarınızın yolu.
   - **Project root** (gelişmiş): komutlar için kullanılan uzak depo yolu.
   - **CLI path** (gelişmiş): çalıştırılabilir bir `openclaw` giriş noktası/ikili dosya için isteğe bağlı yol (ilan edildiğinde otomatik doldurulur).
3. **Test remote**’a tıklayın. Başarı, uzak `openclaw status --json`’ün doğru çalıştığını gösterir. Hatalar genellikle PATH/CLI sorunlarına işaret eder; çıkış 127, CLI’nin uzakta bulunamadığı anlamına gelir.
4. Sağlık kontrolleri ve Web Chat artık otomatik olarak bu SSH tüneli üzerinden çalışır.

## Web Chat

- **SSH tüneli**: Web Chat, yönlendirilmiş WebSocket kontrol portu (varsayılan 18789) üzerinden gateway’e bağlanır.
- **Doğrudan (ws/wss)**: Web Chat, yapılandırılmış gateway URL’sine doğrudan bağlanır.
- Artık ayrı bir WebChat HTTP sunucusu yoktur.

## Permissions

- Uzak ana makine, yerel ile aynı TCC onaylarına ihtiyaç duyar (Otomasyon, Erişilebilirlik, Ekran Kaydı, Mikrofon, Konuşma Tanıma, Bildirimler). Bir kez vermek için o makinede onboarding’i çalıştırın.
- Düğümler, ajanların nelerin kullanılabilir olduğunu bilmesi için izin durumlarını `node.list` / `node.describe` üzerinden ilan eder.

## Güvenlik notları

- Uzak ana makinede loopback bağlamalarını tercih edin ve SSH veya Tailscale üzerinden bağlanın.
- Gateway’i loopback olmayan bir arayüze bağlarsanız, belirteç/parola ile kimlik doğrulama zorunlu kılın.
- [Security](/gateway/security) ve [Tailscale](/gateway/tailscale) bölümlerine bakın.

## WhatsApp giriş akışı (uzak)

- `openclaw channels login --verbose`’yı **uzak ana makinede** çalıştırın. QR kodunu telefonunuzdaki WhatsApp ile tarayın.
- Kimlik doğrulama süresi dolarsa o ana makinede yeniden giriş yapın. Sağlık kontrolü bağlantı sorunlarını gösterecektir.

## Sorun Giderme

- **exit 127 / not found**: `openclaw` etkileşimsiz kabuklar için PATH üzerinde değil. `/etc/paths`’e, kabuk rc dosyanıza ekleyin veya `/usr/local/bin`/`/opt/homebrew/bin` içine sembolik bağlantı oluşturun.
- **Health probe failed**: SSH erişilebilirliğini, PATH’i ve Baileys’in giriş yapmış olduğunu kontrol edin (`openclaw status --json`).
- **Web Chat takılı kalıyor**: gateway’in uzak ana makinede çalıştığını ve yönlendirilen portun gateway WS portuyla eşleştiğini doğrulayın; arayüz sağlıklı bir WS bağlantısı gerektirir.
- **Node IP 127.0.0.1 görünüyor**: SSH tüneli ile beklenen davranıştır. Gateway’in gerçek istemci IP’sini görmesini istiyorsanız **Transport**’u **Doğrudan (ws/wss)** olarak değiştirin.
- **Voice Wake**: tetikleyici ifadeler uzak modda otomatik olarak yönlendirilir; ayrı bir yönlendirici gerekmez.

## Bildirim sesleri

Bildirim başına sesleri, `openclaw` ve `node.invoke` ile betiklerden seçin, örn.:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Uygulamada artık genel bir “varsayılan ses” anahtarı yoktur; çağıranlar her istek için bir ses (ya da hiçbiri) seçer.
