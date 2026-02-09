---
summary: "Exec onayları, izin listeleri ve sandbox kaçış istemleri"
read_when:
  - Exec onaylarını veya izin listelerini yapılandırırken
  - macOS uygulamasında exec onay UX’ini uygularken
  - Sandbox kaçış istemlerini ve etkilerini incelerken
title: "Exec Onayları"
---

# Exec onayları

Exec onayları, sandbox içindeki bir ajanın gerçek bir ana makinede komut çalıştırmasına izin vermek için **yardımcı uygulama / node ana makinesi koruma önlemi**dir
(`gateway` veya `node`). Bunu bir güvenlik kilidi gibi düşünün:
komutlara yalnızca politika + izin listesi + (isteğe bağlı) kullanıcı onayı birlikte uyumlu olduğunda izin verilir.
Exec onayları, araç politikası ve yükseltilmiş kapılamaya **ek** olarak uygulanır (yükseltilmiş mod `full` olarak ayarlanmışsa onaylar atlanır).
Etkili politika, `tools.exec.*` ile onay varsayılanlarının **daha katı** olanıdır; bir onay alanı atlanırsa `tools.exec` değeri kullanılır.

Yardımcı uygulama UI’si **kullanılabilir değilse**, istem gerektiren her istek
**ask fallback** ile çözülür (varsayılan: reddet).

## Nerede uygulanır

Exec onayları yürütme ana makinesinde yerel olarak uygulanır:

- **gateway ana makinesi** → gateway makinesindeki `openclaw` süreci
- **node ana makinesi** → node çalıştırıcısı (macOS yardımcı uygulaması veya başsız node ana makinesi)

macOS ayrımı:

- **node ana makinesi hizmeti**, `system.run`’u yerel IPC üzerinden **macOS uygulamasına** iletir.
- **macOS uygulaması**, onayları uygular + komutu UI bağlamında yürütür.

## Ayarlar ve depolama

Onaylar, yürütme ana makinesinde yerel bir JSON dosyasında tutulur:

`~/.openclaw/exec-approvals.json`

Örnek şema:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## 23. Politika ayar düğmeleri

### Güvenlik (`exec.security`)

- **deny**: tüm ana makine exec isteklerini engelle.
- **allowlist**: yalnızca izin listesindeki komutlara izin ver.
- **full**: her şeye izin ver (yükseltilmiş ile eşdeğer).

### Ask (`exec.ask`)

- **off**: asla istem gösterme.
- **on-miss**: yalnızca izin listesi eşleşmediğinde istem göster.
- **always**: her komutta istem göster.

### Ask fallback (`askFallback`)

Bir istem gerekiyorsa ancak erişilebilir bir UI yoksa, fallback şuna karar verir:

- **deny**: engelle.
- **allowlist**: yalnızca izin listesi eşleşiyorsa izin ver.
- **full**: izin ver.

## İzin listesi (ajan başına)

İzin listeleri **ajan başınadır**. Birden fazla ajan varsa, macOS uygulamasında
düzenlediğiniz ajanı değiştirin. Desenler **büyük/küçük harfe duyarsız glob eşleşmeleri**dir.
Desenler **ikili (binary) yollarına** çözülmelidir (yalnızca dosya adı içeren girdiler yok sayılır).
Eski `agents.default` girdileri yükleme sırasında `agents.main`’ya taşınır.

Örnekler:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Her izin listesi girdisi şunları izler:

- **id** UI kimliği için kullanılan sabit UUID (isteğe bağlı)
- **son kullanıldı** zaman damgası
- **son kullanılan komut**
- **son çözümlenen yol**

## Skill CLI’lerini otomatik izinli yapma

**Auto-allow skill CLIs** etkinleştirildiğinde, bilinen Skills tarafından başvurulan yürütülebilirler
node’larda (macOS node veya başsız node ana makinesi) izinli kabul edilir. Bu,
Gateway RPC üzerinden `skills.bins` kullanarak skill bin listesini getirir. Sıkı manuel izin listeleri istiyorsanız bunu devre dışı bırakın.

## Güvenli bin’ler (yalnızca stdin)

`tools.exec.safeBins`, **stdin-only** ikili dosyaların küçük bir listesini (örneğin `jq`)
tanımlar; bunlar açık izin listesi girdileri **olmadan** izin listesi modunda çalışabilir. Güvenli bin’ler konumsal dosya argümanlarını ve yol benzeri belirteçleri reddeder; böylece yalnızca gelen akış üzerinde çalışabilirler.
Shell zincirleme ve yönlendirmeler izin listesi modunda otomatik olarak izinli değildir.

Shell zincirleme (`&&`, `||`, `;`), her üst düzey bölüm izin listesini sağladığında
( güvenli bin’ler veya skill otomatik izin dahil) izinlidir. Yönlendirmeler izin listesi modunda desteklenmez.
Komut ikamesi (`$()` / ters tırnaklar) izin listesi ayrıştırması sırasında reddedilir; çift tırnakların içinde dahi. Kelimesi kelimesine `$()` metnine ihtiyacınız varsa tek tırnak kullanın.

Varsayılan güvenli bin’ler: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Control UI düzenleme

Varsayılanları, ajan başına
geçersiz kılmaları ve izin listelerini düzenlemek için **Control UI → Nodes → Exec approvals** kartını kullanın. Bir kapsam seçin (Varsayılanlar veya bir ajan), politikayı ayarlayın,
izin listesi desenleri ekleyip çıkarın, ardından **Save**’e basın. UI, listeyi düzenli tutabilmeniz için
desen başına **son kullanıldı** meta verilerini gösterir.

Hedef seçici **Gateway** (yerel onaylar) veya bir **Node** seçer. Node’lar
`system.execApprovals.get/set`’yi (macOS uygulaması veya başsız node ana makinesi) ilan etmelidir.
Bir node henüz exec onaylarını ilan etmiyorsa, yerel
`~/.openclaw/exec-approvals.json`’ini doğrudan düzenleyin.

CLI: `openclaw approvals`, gateway veya node düzenlemeyi destekler (bkz. [Approvals CLI](/cli/approvals)).

## Onay akışı

Bir istem gerektiğinde, gateway operatör istemcilerine `exec.approval.requested`’ı yayınlar.
Control UI ve macOS uygulaması bunu `exec.approval.resolve` aracılığıyla çözer; ardından gateway
onaylanmış isteği node ana makinesine iletir.

Onaylar gerektiğinde, exec aracı hemen bir onay kimliğiyle döner. Bu kimliği,
sonraki sistem olaylarını (`Exec finished` / `Exec denied`) ilişkilendirmek için kullanın. Zaman aşımından önce
bir karar gelmezse, istek onay zaman aşımı olarak değerlendirilir ve bir reddetme gerekçesi olarak sunulur.

Onay iletişim kutusu şunları içerir:

- komut + argümanlar
- cwd
- ajan kimliği
- çözümlenen yürütülebilir yol
- ana makine + politika meta verileri

Eylemler:

- **Allow once** → şimdi çalıştır
- **Always allow** → izin listesine ekle + çalıştır
- **Deny** → engelle

## Sohbet kanallarına onay yönlendirme

Exec onay istemlerini herhangi bir sohbet kanalına (eklenti kanalları dahil) yönlendirebilir ve
`/approve` ile onaylayabilirsiniz. Bu, normal giden teslimat hattını kullanır.

Yapılandırma:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Sohbette yanıtlayın:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC akışı

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Güvenlik notları:

- Unix soket modu `0600`, belirteç `exec-approvals.json`’da saklanır.
- Aynı UID’li eş denetimi.
- Challenge/response (nonce + HMAC belirteci + istek özeti) + kısa TTL.

## Sistem olayları

Exec yaşam döngüsü sistem mesajları olarak sunulur:

- `Exec running` (yalnızca komut çalışma bildirimi eşiğini aşarsa)
- `Exec finished`
- `Exec denied`

Bunlar, node olay raporladıktan sonra ajanın oturumuna gönderilir.
Gateway ana makinesi exec onayları, komut bittiğinde (ve isteğe bağlı olarak eşikten daha uzun sürdüğünde) aynı yaşam döngüsü olaylarını üretir.
Onay kapılı exec’ler, kolay ilişkilendirme için bu mesajlarda `runId` olarak onay kimliğini yeniden kullanır.

## 24. Etkileri

- **full** güçlüdür; mümkün olduğunda izin listelerini tercih edin.
- **ask**, hızlı onaylara izin verirken sizi döngüde tutar.
- Ajan başına izin listeleri, bir ajanın onaylarının diğerlerine sızmasını önler.
- Onaylar yalnızca **yetkili gönderenler**den gelen ana makine exec isteklerine uygulanır. Yetkisiz gönderenler `/exec` veremez.
- `/exec security=full`, yetkili operatörler için oturum düzeyinde bir kolaylıktır ve tasarım gereği onayları atlar.
  Ana makine exec’ini kesin olarak engellemek için onaylar güvenliğini `deny` olarak ayarlayın veya araç politikası üzerinden `exec` aracını reddedin.

İlgili:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
