# OpenClaw Job Completion Supervisor v0

Amaç: ACP / Codex / Gemini gibi arka plan executor'larından gelen completion event'lerini tek yerde normalize etmek, ara/progress spam'ini bastırmak, duplicate event'leri yutmak ve kullanıcıya gösterilecek kısa final özeti üretmek.

## Çekirdek Gereksinimler

- Event kaçırmama:
  - Result dosyası yazıldıktan sonra ayrı bir supervisor bunu görüp state'e işler.
  - Aynı event yeniden gelse bile idempotent davranır.
- Final-only bildirim:
  - `progress`, `heartbeat`, `partial` gibi ara durumlar kullanıcı yüzeyine promote edilmez.
  - Yalnızca terminal durumlar (`succeeded`, `failed`, `cancelled`, `timed_out`) notify adayı olur.
- Kısa otomatik özet:
  - Executor uzun çıktı üretse bile supervisor 1-3 satırlık final özet çıkarır.
  - Mevcut özet zayıfsa fallback kuralı ile türetir.
- Duplicate bastırma:
  - Aynı `jobId + terminal status + summary fingerprint` kombinasyonu tekrar notify edilmez.
- State dosyası güvenliği:
  - `state/supervisor-state.json` okuma/işleme/yazma akışı aynı anda çalışan supervisor prosesleri arasında `fcntl.flock` ile serileştirilir.
  - State yazımı temp dosya + atomik `os.replace` ile yapılır; böylece yarım yazılmış JSON riski azaltılır.
- State retention:
  - Terminal durumdaki job kayıtları son gözlem zamanı 30 günden eskiyse state yazımı sırasında prune edilir.
  - `running` / `queued` / `partial` gibi terminal olmayan eski job kayıtları korunur.
  - State dosyası büyümesini sınırlamak için en fazla 1000 job kaydı ve son 500 event / notification dedupe anahtarı tutulur.
- Workspace uyumu:
  - Mevcut file-queue modeline oturur.
  - OpenClaw orchestrator ile harness/executor ayrımını bozmaz.
- Pratik sözleşme doğrulaması:
  - Adapter çıktıları ve supervisor girdileri `contracts/*.json` dosyalarındaki alan sözleşmelerine göre doğrulanır.
  - Tam bir JSON Schema motoru yoktur; local validator `type`, `required`, `const`, `enum`, `minLength`, `minimum`, `maximum` ve `items` alt kümesini uygular.
  - Geçersiz event/result verisi mevcut CLI sözleşmesine uygun şekilde exit code `2` ile reddedilir.

## Önerilen Dizin

```text
.openclaw/job-supervisor/
├── README.md
├── contracts/
│   ├── completion-event-v1.json
│   └── notification-envelope-v1.json
├── samples/
│   ├── codex-completion.sample.json
│   ├── codex-result.raw.sample.json
│   ├── gemini-result.raw.sample.json
│   └── gemini-progress.sample.json
├── state/
│   └── .gitkeep
└── scripts/
    ├── adapt_codex_result.py
    ├── adapt_gemini_result.py
    ├── consume_notifications.py
    ├── dispatch_raw_result.py
    ├── schema_validation.py
    ├── supervisor_utils.py
    └── supervise_job_events.py
```

## Akış

1. Executor veya harness mevcut `outbound/` result dosyasını üretir.
2. İnce bir adapter bu sonucu `completion-event-v1` formatına yazar veya supervisor doğrudan result dosyasını normalize eder.
3. Adapter ve supervisor contract JSON'larının pratik bir alt kümesiyle payload doğrulaması yapar.
4. Supervisor event'i okur, `state/supervisor-state.json` içine işler.
5. Event terminal ise ve duplicate değilse `notification-envelope-v1` üretir.
6. Dispatcher bu envelope'u dosya tabanlı bir notification outbox'a yazar.
7. Transport katmanı ayrı bir consumer ile outbox'tan envelope okuyup kendi kanalına iletir.

İlk glue entrypoint:

- `scripts/dispatch_raw_result.py` tek bir ham result dosyası veya `--raw-result-dir` ile bir dizin alır
- payload alanlarından Codex/Gemini kaynağını otomatik seçer; `source` alanı varsa onu öncelikli kullanır
- uygun adapter'ı çağırır
- normalize edilmiş event'i mevcut supervisor state akışına verir
- terminal notification çıktılarını `--notifications-dir` altına yazar
- işlenen ham dosyaları `--archive-dir` altına, parse/adapt hatalarını `--error-dir` altına taşır
- stdout'a tekil veya batch supervisor sonucunu basar ve mevcut exit code sözleşmesini korur

Notification tüketim sınırı:

- `scripts/consume_notifications.py` `notification-envelope-v1` dosyalarını bir inbox dizininden okur
- contract doğrulaması yapar
- başarılı okunan envelope'ları archive dizinine taşır
- dış dünyaya gönderim yapmaz; stdout çıktısı ile transport katmanına sade bir handoff noktası sağlar

## Neden Ayrı Supervisor?

Queue `outbound/` tek başına güvenli değil:

- watcher restart olursa completion kaçabilir
- aynı job için birden fazla dosya düşebilir
- progress event'leri kullanıcı yüzeyini kirletir
- kısa final summary üretimi executor'lara bırakılırsa davranış tutarsız olur

Supervisor bu yüzden stateful ve idempotent bir ara katman olmalıdır.

## Event Kuralları

- Bir event'in doğal anahtarı: `source + jobId + sequence`
- Bir job'ın notify anahtarı: `source + jobId + terminal status + summary fingerprint`
- `sequence` yoksa fallback: `completedAtUtc + status + raw path`
- `progressPercent` veya `kind=progress` event'leri state'e yazılır ama notify edilmez
- `finalSummary` yoksa şu sırayla üretilir:
  1. event içindeki `summary`
  2. `result.summary`
  3. `modifiedFiles` + `status` tabanlı türetim
  4. son fallback: `Job completed` / `Job failed`

## Minimal Entegrasyon

- Codex / ACP:
  - Harness result JSON üretince supervisor script'i aynı result path üzerinde çağrılır.
  - Codex için ilk adapter yolu `scripts/adapt_codex_result.py` ile Codex raw result JSON'unu `completion-event-v1` formatına çevirir.
  - Codex raw result tarafında `job_id`, `status`, `completed_at`, `summary`, `files_changed`, `testing`, `open_questions` alanları beklenir; `jobId`, `task_id`, `modified_files` gibi alias'lar da desteklenir.
  - `testing` ve `open_questions` alanları `metrics.testing` / `metrics.openQuestions` altına taşınır; `summary` kısa final özet olarak korunur.
  - Operasyonel Codex drop location: `.openclaw/codex-queue/outbound/*.json`
  - İlk üretici helper: `scripts/write_codex_result.py`
  - Gerçek ACP/Codex session bridge helper: `scripts/bridge_codex_session_to_result.py`
    - kaynak: `~/.openclaw/agents/codex/sessions/sessions.json` + ilgili `*.jsonl`
    - bitmiş bir Codex ACP oturumunun final assistant mesajından raw result üretir
  - Minimal otomasyon entrypoint'i: `scripts/auto_bridge_codex_sessions.py`
    - `status=done` Codex ACP oturumlarını tarar
    - default davranış: yalnızca otomasyon eklendikten sonra bitecek yeni oturumları işler
    - `--include-backlog` verilirse eski bitmiş oturumları da topluca işler
    - henüz işlenmemiş oturumlar için bridge -> dispatch -> consume zincirini çalıştırır
    - kendi küçük state dosyasıyla tekrar işlemeyi engeller
- Gemini queue:
  - `.openclaw/gemini-queue/outbound/*.json` dosyaları supervisor'a normalize edilerek geçirilir.
  - İlk adapter yolu `scripts/adapt_gemini_result.py` ile ham Gemini result JSON'unu `completion-event-v1` formatına çevirir.
- Gelecek:
  - Supervisor daha sonra Discord/desktop/toast notifier'a bağlanabilir.
  - Ama notify transport ayrı kalmalı; supervisor karar katmanı olmalı.

## İlk Uygulanabilir Kural Seti

- Tek state dosyası: `.openclaw/job-supervisor/state/supervisor-state.json`
- Lock dosyası: state dosyasının yanında `.lock` uzantılı sidecar, ör. `supervisor-state.json.lock`
- State retention default'ları:
  - eski terminal job kayıtları: 30 gün
  - maksimum job kaydı: 1000
  - maksimum event / notification dedupe girdisi: 500
- Giriş modları:
  - `--event-file path/to/event.json`
  - `--event-dir path/to/outbound-dir` (dizindeki `*.json` dosyalarını isim sırasıyla tek state load/write içinde işler)
- Tekil event çıktı modu:
  - stdout'a `notification-envelope-v1` veya `{"suppressed": true}` yaz
- Batch çıktı modu:
  - stdout'a `{"processedCount": N, "results": [...]}` yazar
- Exit code:
  - `0`: işlendi
  - `2`: malformed event
  - `3`: duplicate suppressed (tekil `--event-file` modunda)

## Örnek Çalıştırma

Ham Gemini result -> `completion-event-v1`:

```bash
python3 .openclaw/job-supervisor/scripts/adapt_gemini_result.py \
  --raw-result-file .openclaw/job-supervisor/samples/gemini-result.raw.sample.json
```

Ham Codex result -> `completion-event-v1`:

```bash
python3 .openclaw/job-supervisor/scripts/adapt_codex_result.py \
  --raw-result-file .openclaw/job-supervisor/samples/codex-result.raw.sample.json
```

Operasyonel Codex raw result yazmak:

```bash
python3 .openclaw/job-supervisor/scripts/write_codex_result.py \
  --job-id codex-live-smoke-20260403 \
  --status success \
  --summary "Codex raw result helper smoke test'i basarili." \
  --completed-at 2026-04-03T20:57:00Z \
  --sequence 1 \
  --files-changed .openclaw/job-supervisor/scripts/write_codex_result.py,.openclaw/job-supervisor/README.md
```

Bitmiş gerçek Codex ACP oturumundan raw result üretmek:

```bash
python3 .openclaw/job-supervisor/scripts/bridge_codex_session_to_result.py \
  --session-key agent:codex:acp:8a05e7c7-a08c-48e3-b961-012d54c4da0f
```

Sonra bu raw result'u supervisor zincirine vermek:

```bash
python3 .openclaw/job-supervisor/scripts/dispatch_raw_result.py \
  --raw-result-file .openclaw/codex-queue/outbound/agent__codex__acp__8a05e7c7-a08c-48e3-b961-012d54c4da0f.result.json \
  --notifications-dir .openclaw/job-supervisor/state/notifications \
  --archive-dir .openclaw/job-supervisor/state/raw-results-archive \
  --error-dir .openclaw/job-supervisor/state/raw-results-error
```

Minimal otomasyonla yeni bitmiş Codex oturumlarını işlemek:

```bash
python3 .openclaw/job-supervisor/scripts/auto_bridge_codex_sessions.py
```

Sadece neyi işleyeceğini görmek için dry-run:

```bash
python3 .openclaw/job-supervisor/scripts/auto_bridge_codex_sessions.py --dry-run
```

Eski backlog'u bilerek bir kez geçirmek istersen:

```bash
python3 .openclaw/job-supervisor/scripts/auto_bridge_codex_sessions.py --include-backlog
```

```bash
python3 .openclaw/job-supervisor/scripts/supervise_job_events.py \
  --event-file .openclaw/job-supervisor/samples/codex-completion.sample.json
```

Ham result dosyasını doğrudan adapter + supervisor pipeline'ına vermek:

```bash
python3 .openclaw/job-supervisor/scripts/dispatch_raw_result.py \
  --raw-result-file .openclaw/job-supervisor/samples/codex-result.raw.sample.json \
  --notifications-dir /tmp/job-supervisor-notifications \
  --archive-dir /tmp/job-supervisor-archive \
  --error-dir /tmp/job-supervisor-errors
```

Ham result dizinini batch işlemek:

```bash
python3 .openclaw/job-supervisor/scripts/dispatch_raw_result.py \
  --raw-result-dir /path/to/outbound \
  --notifications-dir /tmp/job-supervisor-notifications \
  --archive-dir /tmp/job-supervisor-archive \
  --error-dir /tmp/job-supervisor-errors
```

Notification outbox tüketmek:

```bash
python3 .openclaw/job-supervisor/scripts/consume_notifications.py \
  --notifications-dir /tmp/job-supervisor-notifications \
  --archive-dir /tmp/job-supervisor-notifications-archive
```

```bash
python3 .openclaw/job-supervisor/scripts/supervise_job_events.py \
  --event-dir .openclaw/job-supervisor/samples
```

## Açık Noktalar

- Gemini queue ham result formatı için ilk gerçek adapter eklendi.
- Codex raw result için ilk adapter yolu eklendi; ACP completion event'inin gerçek ham formatı bu workspace'te henüz sabit değil.
