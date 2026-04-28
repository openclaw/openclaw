# OpenClaw ve Gemini CLI Entegrasyon Sözleşmesi

Bu belge, OpenClaw (Ceviz) sistemi ile Gemini CLI arasında **Codex-benzeri otonom bir geliştirici iş akışı** kurmak için gerekli kuralları tanımlar. Amaç, Gemini CLI'ın arka planda sürekli çalışan, görevleri alıp kod yazan/değiştiren ve sonuçları raporlayan sessiz bir yardımcı (copilot/agent) gibi davranmasını sağlamaktır.

## 1. Otonom İş Akışı (Codex-like Workflow)

Sistem, dosya tabanlı bir kuyruk (queue) ve izleyici (watcher) mimarisiyle çalışır.

1. **İstek (Prompt) Üretimi:** OpenClaw ana sistemi (veya kullanıcı), yapılacak işi standart bir JSON sözleşmesiyle paketler.
2. **Kuyruklama:** JSON dosyası `inbound/` klasörüne bırakılır.
3. **Tetikleme (Watcher):** Bir arka plan betiği (örn. `gemini-watcher.ps1/sh`) `inbound/` klasörünü dinler. Yeni dosya geldiğinde Gemini CLI'ı otomatik çalıştırır.
4. **İcra (Execution):** Gemini CLI dosyaları okur, kodu yazar/değiştirir, testleri çalıştırır.
5. **Yanıt (Result):** Gemini CLI işi bitirince `outbound/` klasörüne durumu yazar.

**Dizin Yapısı:**

- `.openclaw/gemini-queue/inbound/` (OpenClaw görev bırakır, Gemini işler)
- `.openclaw/gemini-queue/outbound/` (Gemini sonuçları bırakır, OpenClaw okur)
- `.openclaw/gemini-queue/archive/` (Tamamlanan veya hatalı görevler buraya taşınır)

## 2. Veri Sözleşmesi (Contract)

### İstek Formatı (`inbound/task-{id}.json`)

```json
{
  "task_id": "benzersiz-id",
  "timestamp": "2026-04-02T00:00:00Z",
  "context_files": ["src/main.py", "docs/api.md"],
  "instruction": "API dokümantasyonuna uygun olarak main.py içindeki eksik endpoint'i implement et ve testlerini yaz.",
  "strict_mode": true,
  "expected_output": "outbound/result-{id}.json"
}
```

### Yanıt Formatı (`outbound/result-{id}.json`)

```json
{
  "task_id": "benzersiz-id",
  "status": "success | error",
  "completed_at": "2026-04-02T00:05:00Z",
  "summary": "Endpoint implement edildi ve testler başarıyla geçti.",
  "modified_files": ["src/main.py", "tests/test_main.py"],
  "error_details": null
}
```

## 3. Çalıştırma Talimatı ve İzleyici (Watcher)

Arka planda çalışacak `gemini-watcher` döngüsü şu mantıkla çalışmalıdır:

```bash
# Örnek Pseudo-Kod İzleyici
while true; do
  for task in inbound/*.json; do
    gemini "Şu görevi oku ve harfiyen yerine getir: $task. Sonucu belirtilen expected_output yoluna yaz. Asla insan onayı bekleme, değişiklikleri doğrudan yap."
    mv $task archive/
  done
  sleep 5
done
```

## 4. Uygulama Kontrol Listesi (Checklist)

- [ ] `inbound`, `outbound`, `archive` klasörlerinin oluşturulması.
- [ ] JSON sözleşmesine uygun ilk örnek görevin elle oluşturulması.
- [ ] `gemini-watcher.sh` (Linux/Mac) ve `gemini-watcher.ps1` (Windows) betiklerinin yazılması.
- [ ] Gemini CLI prompt'larının "sessiz, onay beklemeden sadece kod yazan" (Codex-like) bir profile ayarlanması.
