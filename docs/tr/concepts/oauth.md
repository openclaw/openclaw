---
summary: "OpenClaw’da OAuth: belirteç değişimi, depolama ve çoklu hesap desenleri"
read_when:
  - OpenClaw OAuth’u uçtan uca anlamak istiyorsunuz
  - Belirteç geçersizleşmesi / oturum kapatma sorunlarıyla karşılaşıyorsunuz
  - setup-token veya OAuth kimlik doğrulama akışlarını istiyorsunuz
  - Birden fazla hesap veya profil yönlendirmesi istiyorsunuz
title: "OAuth"
---

# OAuth

OpenClaw, bunu sunan sağlayıcılar için OAuth üzerinden “abonelik kimlik doğrulaması”nı destekler (özellikle **OpenAI Codex (ChatGPT OAuth)**). Anthropic abonelikleri için **setup-token** akışını kullanın. Bu sayfa şunları açıklar:

- OAuth **belirteç değişiminin** (PKCE) nasıl çalıştığı
- belirteçlerin **nerede depolandığı** (ve neden)
- **birden fazla hesabın** nasıl ele alınacağı (profiller + oturum başına geçersiz kılmalar)

OpenClaw ayrıca kendi OAuth veya API anahtarı
akışlarını sağlayan **sağlayıcı eklentilerini** de destekler. Şu şekilde çalıştırın:

```bash
openclaw models auth login --provider <id>
```

## The token sink (why it exists)

OAuth sağlayıcıları, giriş/yenileme akışları sırasında genellikle **yeni bir yenileme belirteci** üretir. Bazı sağlayıcılar (veya OAuth istemcileri), aynı kullanıcı/uygulama için yeni bir belirteç verildiğinde daha eski yenileme belirteçlerini geçersiz kılabilir.

Pratik belirti:

- OpenClaw _ve_ Claude Code / Codex CLI üzerinden giriş yaparsınız → birisi daha sonra rastgele “oturumdan atılır”

Bunu azaltmak için OpenClaw, `auth-profiles.json`’i bir **belirteç havuzu** olarak ele alır:

- çalışma zamanı kimlik bilgilerini **tek bir yerden** okur
- birden fazla profili tutabilir ve bunları deterministik biçimde yönlendirebiliriz

## Depolama (belirteçler nerede tutulur)

Gizli bilgiler **ajan başına** depolanır:

- Kimlik doğrulama profilleri (OAuth + API anahtarları): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Çalışma zamanı önbelleği (otomatik olarak yönetilir; düzenlemeyin): `~/.openclaw/agents/<agentId>/agent/auth.json`

Eski, yalnızca içe aktarma amaçlı dosya (hala desteklenir, ancak ana depo değildir):

- `~/.openclaw/credentials/oauth.json` (ilk kullanımda `auth-profiles.json` içine içe aktarılır)

Yukarıdakilerin tümü ayrıca `$OPENCLAW_STATE_DIR`’a (durum dizini geçersiz kılması) saygı duyar. Tam başvuru: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (abonelik kimlik doğrulaması)

Herhangi bir makinede `claude setup-token` çalıştırın, ardından OpenClaw’a yapıştırın:

```bash
openclaw models auth setup-token --provider anthropic
```

Belirteci başka bir yerde oluşturduysanız, manuel olarak yapıştırın:

```bash
openclaw models auth paste-token --provider anthropic
```

Doğrulayın:

```bash
openclaw models status
```

## OAuth değişimi (giriş nasıl çalışır)

OpenClaw’ın etkileşimli giriş akışları `@mariozechner/pi-ai` içinde uygulanır ve sihirbazlara/komutlara bağlanır.

### Anthropic (Claude Pro/Max) setup-token

Akış şekli:

1. `claude setup-token` çalıştırın
2. belirteci OpenClaw’a yapıştırın
3. bir belirteç kimlik doğrulama profili olarak kaydedin (yenileme yok)

Sihirbaz yolu: `openclaw onboard` → kimlik doğrulama seçimi `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Akış şekli (PKCE):

1. PKCE doğrulayıcı/zorluk + rastgele `state` üretin
2. `https://auth.openai.com/oauth/authorize?...`’yi açın
3. `http://127.0.0.1:1455/auth/callback` üzerinde geri çağrıyı yakalamaya çalışın
4. geri çağrı bağlanamazsa (veya uzaktan/başsızsanız), yönlendirme URL’sini/kodunu yapıştırın
5. `https://auth.openai.com/oauth/token`’da değişim yapın
6. erişim belirtecinden `accountId`’i çıkarın ve `{ access, refresh, expires, accountId }`’i saklayın

Sihirbaz yolu: `openclaw onboard` → kimlik doğrulama seçimi `openai-codex`.

## Yenileme + sona erme

Profiller bir `expires` zaman damgası saklar.

Çalışma zamanında:

- `expires` gelecekteyse → depolanan erişim belirtecini kullan
- süresi dolmuşsa → yenile (dosya kilidi altında) ve depolanan kimlik bilgilerini üzerine yaz

Yenileme akışı otomatiktir; genellikle belirteçleri manuel olarak yönetmeniz gerekmez.

## Birden fazla hesap (profiller) + yönlendirme

İki desen:

### 1. Tercih edilen: ayrı ajanlar

“kişisel” ve “iş”in asla etkileşime girmemesini istiyorsanız, yalıtılmış ajanlar kullanın (ayrı oturumlar + kimlik bilgileri + çalışma alanı):

```bash
openclaw agents add work
openclaw agents add personal
```

Ardından ajan başına kimlik doğrulamayı (sihirbaz) yapılandırın ve sohbetleri doğru ajana yönlendirin.

### 2. Gelişmiş: tek ajan içinde birden fazla profil

`auth-profiles.json`, aynı sağlayıcı için birden fazla profil kimliğini destekler.

Hangi profilin kullanılacağını seçin:

- yapılandırma sıralamasıyla küresel olarak (`auth.order`)
- oturum başına `/model ...@<profileId>` ile

Örnek (oturum geçersiz kılması):

- `/model Opus@anthropic:work`

Mevcut profil kimliklerini nasıl görebilirsiniz:

- `openclaw channels list --json` (`auth[]`’i gösterir)

İlgili belgeler:

- [/concepts/model-failover](/concepts/model-failover) (döndürme + bekleme süresi kuralları)
- [/tools/slash-commands](/tools/slash-commands) (komut yüzeyi)
