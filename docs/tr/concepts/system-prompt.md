---
summary: "OpenClaw sistem isteminin neleri içerdiği ve nasıl birleştirildiği"
read_when:
  - Sistem istemi metnini, araçlar listesini veya zaman/heartbeat bölümlerini düzenlerken
  - Çalışma alanı önyüklemesi veya skills enjeksiyonu davranışını değiştirirken
title: "Sistem İstemi"
---

# Sistem İstemi

OpenClaw, her ajan çalıştırması için özel bir sistem istemi oluşturur. İstem **OpenClaw’a aittir** ve p-coding-agent varsayılan istemini kullanmaz.

İstem, OpenClaw tarafından birleştirilir ve her ajan çalıştırmasına enjekte edilir.

## Yapı

İstem kasıtlı olarak kompakt tutulur ve sabit bölümler kullanır:

- **Tooling**: geçerli araç listesi + kısa açıklamalar.
- **Safety**: güç arayışlı davranışlardan veya gözetimi aşmaktan kaçınmaya yönelik kısa bir koruyucu hatırlatma.
- **Skills** (mevcut olduğunda): modelin skill talimatlarını talep üzerine nasıl yükleyeceğini belirtir.
- **OpenClaw Self-Update**: `config.apply` ve `update.run`’nin nasıl çalıştırılacağı.
- **Workspace**: çalışma dizini (`agents.defaults.workspace`).
- **Documentation**: OpenClaw dokümanlarının yerel yolu (repo veya npm paketi) ve ne zaman okunacağı.
- **Workspace Files (injected)**: önyükleme dosyalarının aşağıda dahil edildiğini belirtir.
- **Sandbox** (etkinleştirildiğinde): sandbox’lanmış çalışma zamanı, sandbox yolları ve yükseltilmiş exec’in mevcut olup olmadığı.
- **Current Date & Time**: kullanıcıya yerel tarih/saat, zaman dilimi ve zaman biçimi.
- **Reply Tags**: desteklenen sağlayıcılar için isteğe bağlı yanıt etiketi söz dizimi.
- **Heartbeats**: heartbeat istemi ve onay davranışı.
- **Runtime**: ana makine, OS, node, model, repo kökü (tespit edildiğinde), düşünme seviyesi (tek satır).
- **Reasoning**: geçerli görünürlük seviyesi + /reasoning geçiş ipucu.

Sistem istemindeki güvenlik korumaları tavsiye niteliğindedir. Model davranışını yönlendirir ancak politika dayatmaz. Katı uygulama için araç politikası, çalıştırma onayları, sandboxing ve kanal izin listelerini kullanın; operatörler bunları tasarım gereği devre dışı bırakabilir.

## Prompt modes

OpenClaw, alt ajanlar için daha küçük sistem istemleri oluşturabilir. Çalışma zamanı her çalıştırma için kullanıcıya açık olmayan bir yapılandırma olarak `promptMode` ayarlar:

- `full` (varsayılan): yukarıdaki tüm bölümleri içerir.
- `minimal`: alt ajanlar için kullanılır; **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** ve **Heartbeats** bölümlerini hariç tutar. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (biliniyorsa), Runtime ve enjekte edilen
  bağlam erişilebilir kalır.
- `none`: yalnızca temel kimlik satırını döndürür.

`promptMode=minimal` olduğunda, ek enjekte edilen istemler **Group Chat Context** yerine **Subagent
Context** olarak etiketlenir.

## Çalışma alanı önyükleme enjeksiyonu

Önyükleme dosyaları, modelin kimlik ve profil bağlamını açık okumalara gerek duymadan görmesi için **Project Context** altında kırpılarak eklenir:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (yalnızca yepyeni çalışma alanlarında)

Büyük dosyalar bir işaretleyici ile kısaltılır. Dosya başına azami boyut
`agents.defaults.bootstrapMaxChars` (varsayılan: 20000) ile denetlenir. Eksik dosyalar kısa bir
eksik-dosya işaretleyicisi enjekte eder.

Dahili kancalar, enjekte edilen önyükleme dosyalarını dönüştürmek veya değiştirmek için bu adımı `agent:bootstrap` aracılığıyla kesintiye uğratabilir (örneğin `SOUL.md`’i alternatif bir persona ile değiştirmek).

Her enjekte edilen dosyanın ne kadar katkıda bulunduğunu (ham vs. enjekte edilmiş, kırpma ve araç şeması ek yükü dahil) incelemek için `/context list` veya `/context detail` kullanın. [Context](/concepts/context) bölümüne bakın.

## Zaman yönetimi

Kullanıcı zaman dilimi bilindiğinde sistem istemi özel bir **Current Date & Time** bölümü içerir. İstem önbelleğini kararlı tutmak için artık yalnızca **zaman dilimini** içerir (dinamik saat veya zaman biçimi yoktur).

Ajanın geçerli zamana ihtiyaç duyduğu durumlarda `session_status` kullanın; durum kartı bir zaman damgası satırı içerir.

Aşağıdakilerle yapılandırın:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Tüm davranış ayrıntıları için [Date & Time](/date-time) bölümüne bakın.

## Skills

Uygun skills mevcut olduğunda OpenClaw, her skill için **dosya yolunu** içeren kompakt bir **mevcut skills listesi**
(`formatSkillsForPrompt`) enjekte eder. İstem, modelin listelenen konumdaki
(workspace, managed veya bundled) SKILL.md’yi yüklemek için `read`’i kullanmasını
öğretir. Uygun skill yoksa Skills bölümü atlanır.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Bu yaklaşım, hedefli skill kullanımını mümkün kılarken temel istemi küçük tutar.

## Documentation

Mevcut olduğunda sistem istemi, yerel OpenClaw dokümanları dizinine işaret eden bir **Documentation** bölümü içerir
(repo çalışma alanında `docs/` veya paketlenmiş npm dokümanları) ve ayrıca herkese açık
ayna, kaynak repo, topluluk Discord’u ve skill keşfi için ClawHub’ı
([https://clawhub.com](https://clawhub.com)) belirtir. İstem, OpenClaw davranışı, komutlar,
yapılandırma veya mimari için modelin önce yerel dokümanlara başvurmasını ve mümkün olduğunda
`openclaw status`’u kendisinin çalıştırmasını (erişimi yoksa yalnızca kullanıcıya sormasını) talimatlandırır.
