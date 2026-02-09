---
summary: "Exec aracının kullanımı, stdin modları ve TTY desteği"
read_when:
  - Exec aracını kullanırken veya değiştirirken
  - Stdin veya TTY davranışını hata ayıklarken
title: "Exec Aracı"
---

# Exec aracı

Çalışma alanında kabuk komutlarını çalıştırır. `process` aracılığıyla ön plan + arka plan yürütmeyi destekler.
`process` izinli değilse, `exec` eşzamanlı çalışır ve `yieldMs`/`background` yok sayılır.
Arka plan oturumları ajan bazında kapsamlandırılır; `process` yalnızca aynı ajana ait oturumları görür.

## Parametreler

- `command` (gerekli)
- `workdir` (varsayılan: cwd)
- `env` (anahtar/değer geçersiz kılmaları)
- `yieldMs` (varsayılan 10000): gecikmeden sonra otomatik arka plan
- `background` (bool): hemen arka plan
- `timeout` (saniye, varsayılan 1800): süre dolunca sonlandır
- `pty` (bool): mümkün olduğunda bir sahte terminalde çalıştır (yalnızca TTY CLI'da çalışan araçlar, kodlama ajanları, terminal UI'leri)
- `host` (`sandbox | gateway | node`): nerede yürütüleceği
- `security` (`deny | allowlist | full`): `gateway`/`node` için zorunlu kılma modu
- `ask` (`off | on-miss | always`): `gateway`/`node` için onay istemleri
- `node` (string): `host=node` için düğüm kimliği/adı
- `elevated` (bool): yükseltilmiş mod iste (gateway ana makinesi); `security=full` yalnızca yükseltilmiş durum `full` olarak çözümlendiğinde zorlanır

Notlar:

- `host` varsayılan olarak `sandbox`'dir.
- `elevated`, sandboxing kapalıyken yok sayılır (exec zaten ana makinede çalışır).
- `gateway`/`node` onayları `~/.openclaw/exec-approvals.json` tarafından denetlenir.
- `node` eşleştirilmiş bir düğüm gerektirir (yardımcı uygulama veya başsız düğüm ana makinesi).
- Birden fazla düğüm varsa, birini seçmek için `exec.node` veya `tools.exec.node` ayarlayın.
- Windows olmayan ana makinelerde, ayarlıysa exec `SHELL` kullanır; `SHELL` `fish` ise,
  balık kabuğuyla uyumsuz betiklerden kaçınmak için `PATH` içinden `bash` (veya `sh`) tercih edilir,
  her ikisi de yoksa `SHELL`'ye geri düşer.
- Ana makinede yürütme (`gateway`/`node`), ikili ele geçirilmesini veya enjekte edilmiş kodu
  önlemek için `env.PATH` ve yükleyici geçersiz kılmalarını (`LD_*`/`DYLD_*`) reddeder.
- Önemli: sandboxing **varsayılan olarak kapalıdır**. Sandboxing kapalıysa, `host=sandbox` doğrudan
  gateway ana makinesinde (konteyner yok) çalışır ve **onay gerektirmez**. Onay gerektirmek için
  `host=gateway` ile çalıştırın ve exec onaylarını yapılandırın (veya sandboxing'i etkinleştirin).

## Yapılandırma

- `tools.exec.notifyOnExit` (varsayılan: true): true olduğunda, arka plana alınmış exec oturumları bir sistem olayı kuyruğa alır ve çıkışta bir heartbeat ister.
- `tools.exec.approvalRunningNoticeMs` (varsayılan: 10000): onay gerektiren bir exec bu süreden uzun sürerse tek bir “çalışıyor” bildirimi yayar (0 devre dışı bırakır).
- `tools.exec.host` (varsayılan: `sandbox`)
- `tools.exec.security` (varsayılan: sandbox için `deny`, ayarlanmadığında gateway + düğüm için `allowlist`)
- `tools.exec.ask` (varsayılan: `on-miss`)
- `tools.exec.node` (varsayılan: ayarlanmamış)
- `tools.exec.pathPrepend`: exec çalıştırmaları için `PATH`'in başına eklenecek dizinlerin listesi.
- `tools.exec.safeBins`: açık izin listesi girdileri olmadan çalışabilen, yalnızca stdin kullanan güvenli ikililer.

Örnek:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH işleme

- `host=gateway`: giriş kabuğunuzun `PATH`'ini exec ortamına birleştirir. Ana makinede yürütme için
  `env.PATH` geçersiz kılmaları reddedilir. Daemon'un kendisi yine de asgari bir `PATH` ile çalışır:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: konteyner içinde `sh -lc` (giriş kabuğu) çalıştırır; bu nedenle `/etc/profile`, `PATH`'yi sıfırlayabilir.
  OpenClaw, profil kaynaklamasından sonra dahili bir ortam değişkeni aracılığıyla `env.PATH`'i başa ekler (kabuk enterpolasyonu yok);
  `tools.exec.pathPrepend` burada da geçerlidir.
- `host=node`: yalnızca ilettiğiniz engellenmemiş ortam geçersiz kılmaları düğüme gönderilir. Ana makinede yürütme için
  `env.PATH` geçersiz kılmaları reddedilir. Başsız düğüm ana makineleri `PATH`'yi yalnızca
  düğüm ana makinesi PATH'inin başına eklediğinde kabul eder (değiştirme yok). macOS düğümleri `PATH` geçersiz kılmalarını tamamen düşürür.

Ajan başına düğüm bağlama (yapılandırmada ajan liste indeksini kullanın):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Denetim UI'si: Nodes sekmesi aynı ayarlar için küçük bir “Exec node binding” paneli içerir.

## 25. Oturum geçersiz kılmaları (`/exec`)

`/exec` kullanarak `host`, `security`, `ask` ve `node` için **oturum başına**
varsayılanları ayarlayın.
Geçerli değerleri göstermek için bağımsız değişkensiz `/exec` gönderin.

Örnek:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Yetkilendirme modeli

`/exec` yalnızca **yetkili gönderenler** için geçerlidir (kanal izin listeleri/eşleştirme artı `commands.useAccessGroups`).
Yalnızca **oturum durumunu** günceller ve yapılandırmaya yazmaz. Exec'i kalıcı olarak devre dışı bırakmak için,
araç politikası üzerinden (`tools.deny: ["exec"]` veya ajan başına) reddedin. Ana makine onayları,
`security=full` ve `ask=off`'i açıkça ayarlamadığınız sürece geçerlidir.

## Exec onayları (yardımcı uygulama / düğüm ana makinesi)

Sandbox'lı ajanlar, `exec` gateway veya düğüm ana makinesinde çalışmadan önce istek başına onay gerektirebilir.
Politika, izin listesi ve UI akışı için [Exec approvals](/tools/exec-approvals) sayfasına bakın.

Onaylar gerektiğinde, exec aracı hemen
`status: "approval-pending"` ve bir onay kimliği ile döner. Onaylandıktan (veya reddedildikten / zaman aşımına uğradıktan) sonra
Gateway sistem olayları yayar (`Exec finished` / `Exec denied`). Komut `tools.exec.approvalRunningNoticeMs` sonrasında hâlâ çalışıyorsa,
tek bir `Exec running` bildirimi yayılır.

## İzin listesi + güvenli ikililer

İzin listesi zorlaması **yalnızca çözümlenmiş ikili yollarını** eşleştirir (basename eşleşmesi yok). `security=allowlist` durumunda, kabuk komutları yalnızca her bir boru hattı parçası izin listesinde veya bir güvenli ikili ise
otomatik olarak izinli sayılır. Zincirleme (`;`, `&&`, `||`) ve yönlendirmeler,
izin listesi modunda reddedilir.

## Örnekler

Ön plan:

```json
{ "tool": "exec", "command": "ls -la" }
```

Arka plan + yoklama:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Tuş gönderme (tmux tarzı):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Gönder (yalnızca CR gönder):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

26. Yapıştır (varsayılan olarak köşeli parantez içinde):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (deneysel)

`apply_patch`, yapılandırılmış çok dosyalı düzenlemeler için `exec`'nin bir alt aracıdır.
Açıkça etkinleştirin:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Notlar:

- Yalnızca OpenAI/OpenAI Codex modelleri için kullanılabilir.
- Araç politikası hâlâ geçerlidir; `allow: ["exec"]`, `apply_patch`'a örtük olarak izin verir.
- Yapılandırma `tools.exec.applyPatch` altında bulunur.
