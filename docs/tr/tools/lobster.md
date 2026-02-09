---
title: Lobster
summary: "Onay kapılarıyla devam ettirilebilir, OpenClaw için tipli iş akışı çalışma zamanı."
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - Açık onaylarla deterministik çok adımlı iş akışları istiyorsunuz
  - Önceki adımları yeniden çalıştırmadan bir iş akışını sürdürmeniz gerekiyor
---

# Lobster

Lobster, OpenClaw’un çok adımlı araç dizilerini tek, deterministik bir işlem olarak, açık onay kontrol noktalarıyla çalıştırmasını sağlayan bir iş akışı kabuğudur.

## Hook

Asistanınız kendisini yöneten araçları oluşturabilir. Bir iş akışı isteyin; 30 dakika sonra tek bir çağrı olarak çalışan bir CLI ve boru hatlarınız olsun. Lobster eksik parçadır: deterministik boru hatları, açık onaylar ve devam ettirilebilir durum.

## Why

Günümüzde karmaşık iş akışları birçok ileri-geri araç çağrısı gerektirir. Her çağrı token maliyeti doğurur ve LLM her adımı orkestre etmek zorunda kalır. Lobster bu orkestrasyonu tipli bir çalışma zamanına taşır:

- **Birden çoğu yerine tek çağrı**: OpenClaw tek bir Lobster araç çağrısı çalıştırır ve yapılandırılmış bir sonuç alır.
- **Yerleşik onaylar**: Yan etkiler (e‑posta gönderme, yorum yayınlama) açıkça onaylanana kadar iş akışını durdurur.
- **Devam ettirilebilir**: Durdurulan iş akışları bir belirteç döndürür; her şeyi yeniden çalıştırmadan onaylayıp devam edebilirsiniz.

## Why a DSL instead of plain programs?

Lobster bilerek küçük tutulmuştur. Amaç “yeni bir dil” değil; birinci sınıf onaylar ve devam belirteçleri olan, öngörülebilir ve AI‑dostu bir boru hattı tanımıdır.

- **Onay/Devam yerleşik**: Normal bir program bir insanı uyarabilir, ancak kalıcı bir belirteçle _duraklatıp devam ettirmeyi_ kendi çalışma zamanınızı icat etmeden yapamaz.
- **Deterministiklik + denetlenebilirlik**: Boru hatları veridir; bu da günlükleme, fark alma, yeniden oynatma ve gözden geçirmeyi kolaylaştırır.
- **AI için kısıtlı yüzey**: Küçük bir gramer + JSON borulama “yaratıcı” kod yollarını azaltır ve doğrulamayı gerçekçi kılar.
- **Güvenlik politikası yerleşik**: Zaman aşımları, çıktı sınırları, sandbox kontrolleri ve izin listeleri her betikte değil, çalışma zamanında zorlanır.
- **Hâlâ programlanabilir**: Her adım herhangi bir CLI veya betiği çağırabilir. JS/TS istiyorsanız, koddan `.lobster` dosyaları üretin.

## How it works

OpenClaw, yerel `lobster` CLI’sini **tool mode**’da başlatır ve stdout’tan bir JSON zarfını ayrıştırır.
Boru hattı onay için duraklarsa, aracı daha sonra devam edebilmeniz için bir `resumeToken` döndürür.

## Pattern: small CLI + JSON pipes + approvals

JSON konuşan küçük komutlar oluşturun, ardından bunları tek bir Lobster çağrısında zincirleyin. (Aşağıdaki komut adları örnektir — kendi adlarınızı kullanın.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

31. Ardışık düzen onay isterse, belirteçle devam edin:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI iş akışını tetikler; Lobster adımları yürütür. Onay kapıları yan etkileri açık ve denetlenebilir tutar.

Örnek: girdileri araç çağrılarına eşleyin:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

**Yapılandırılmış bir LLM adımı** gerektiren iş akışları için isteğe bağlı
`llm-task` eklenti aracını etkinleştirip Lobster’dan çağırın. Bu, modelle sınıflandırma/özetleme/taslak oluşturmayı mümkün kılarken iş akışını deterministik tutar.

Aracı etkinleştirin:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

Bir boru hattında kullanın:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

Ayrıntılar ve yapılandırma seçenekleri için [LLM Task](/tools/llm-task) sayfasına bakın.

## Workflow files (.lobster)

Lobster, `name`, `args`, `steps`, `env`, `condition` ve `approval` alanlarına sahip YAML/JSON iş akışı dosyalarını çalıştırabilir. OpenClaw araç çağrılarında, dosya yoluna `pipeline` ayarlayın.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Notlar:

- `stdin: $step.stdout` ve `stdin: $step.json`, önceki bir adımın çıktısını geçirir.
- `condition` (veya `when`), adımları `$step.approved` üzerinde kapılayabilir.

## Install Lobster

Lobster CLI’sini OpenClaw Gateway’i çalıştıran **aynı ana makineye** kurun ([Lobster deposuna](https://github.com/openclaw/lobster) bakın) ve `lobster`’nin `PATH` üzerinde olduğundan emin olun.
Özel bir ikili konum kullanmak istiyorsanız, araç çağrısında **mutlak** bir `lobsterPath` geçin.

## Enable the tool

Lobster **isteğe bağlı** bir eklenti aracıdır (varsayılan olarak etkin değildir).

Önerilen (ekleyici, güvenli):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

32. Veya ajan başına:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

Kısıtlayıcı izin listesi modunda çalıştırmayı amaçlamıyorsanız `tools.allow: ["lobster"]` kullanmaktan kaçının.

Not: izin listeleri isteğe bağlı eklentiler için opt‑in’dir. İzin listeniz yalnızca
eklenti araçlarını (ör. `lobster`) adlandırıyorsa, OpenClaw çekirdek araçları etkin tutar. Çekirdek
araçları kısıtlamak için, izin listesine istediğiniz çekirdek araçları veya grupları da ekleyin.

## Example: Email triage

Lobster olmadan:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

Lobster ile:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Bir JSON zarfı döner (kısaltılmış):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

Kullanıcı onaylar → devam:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Tek iş akışı. Deterministik. Güvenli.

## Tool parameters

### `run`

Bir boru hattını tool mode’da çalıştırın.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Argümanlarla bir iş akışı dosyası çalıştırın:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Onaydan sonra durdurulmuş bir iş akışına devam edin.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `lobsterPath`: Lobster ikilisinin mutlak yolu ( `PATH` kullanmak için boş bırakın).
- `cwd`: Boru hattı için çalışma dizini (varsayılan: geçerli sürecin çalışma dizini).
- `timeoutMs`: Bu süre aşılırsa alt süreci sonlandırın (varsayılan: 20000).
- `maxStdoutBytes`: stdout bu boyutu aşarsa alt süreci sonlandırın (varsayılan: 512000).
- `argsJson`: `lobster run --args-json`’e geçirilen JSON dizesi (yalnızca iş akışı dosyaları).

## Output envelope

Lobster üç durumdan biriyle bir JSON zarfı döndürür:

- `ok` → başarıyla tamamlandı
- `needs_approval` → duraklatıldı; devam etmek için `requiresApproval.resumeToken` gerekir
- `cancelled` → açıkça reddedildi veya iptal edildi

Araç, zarfı hem `content` (güzel yazdırılmış JSON) hem de `details` (ham nesne) olarak sunar.

## Approvals

`requiresApproval` mevcutsa, istemi inceleyin ve karar verin:

- `approve: true` → devam et ve yan etkileri sürdür
- `approve: false` → iptal et ve iş akışını sonlandır

Özel jq/heredoc yapıştırması olmadan onay isteklerine bir JSON önizlemesi eklemek için `approve --preview-from-stdin --limit N` kullanın. Devam belirteçleri artık kompakt: Lobster, iş akışı devam durumunu kendi durum dizini altında saklar ve küçük bir belirteç anahtarı geri verir.

## OpenProse

OpenProse, Lobster ile iyi eşleşir: çok ajanlı hazırlığı orkestre etmek için `/prose` kullanın, ardından deterministik onaylar için bir Lobster boru hattı çalıştırın. Bir Prose programının Lobster’a ihtiyacı varsa, alt ajanlar için `lobster` aracına `tools.subagents.tools` üzerinden izin verin. [OpenProse](/prose) sayfasına bakın.

## Safety

- **Yalnızca yerel alt süreç** — eklentinin kendisinden ağ çağrısı yoktur.
- **Gizli bilgi yok** — Lobster OAuth yönetmez; bunu yapan OpenClaw araçlarını çağırır.
- **Sandbox uyumlu** — araç bağlamı sandboxed olduğunda devre dışıdır.
- **Sertleştirilmiş** — belirtildiyse `lobsterPath` mutlak olmalıdır; zaman aşımları ve çıktı sınırları zorlanır.

## Troubleshooting

- **`lobster subprocess timed out`** → `timeoutMs`’i artırın veya uzun bir boru hattını bölün.
- **`lobster output exceeded maxStdoutBytes`** → `maxStdoutBytes`’ü yükseltin veya çıktı boyutunu azaltın.
- **`lobster returned invalid JSON`** → boru hattının tool mode’da çalıştığından ve yalnızca JSON yazdırdığından emin olun.
- **`lobster failed (code …)`** → stderr’i incelemek için aynı boru hattını bir terminalde çalıştırın.

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## Case study: community workflows

Herkese açık bir örnek: üç Markdown kasasını (kişisel, partner, paylaşılan) yöneten bir “ikinci beyin” CLI’si + Lobster boru hatları. CLI; istatistikler, gelen kutusu listeleri ve bayat taramalar için JSON üretir; Lobster bu komutları `weekly-review`, `inbox-triage`, `memory-consolidation` ve `shared-task-sync` gibi, her biri onay kapıları olan iş akışlarına zincirler. AI mevcut olduğunda muhakemeyi (kategorizasyon) üstlenir, olmadığında deterministik kurallara geri döner.

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
