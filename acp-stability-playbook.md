# ACP Stability Playbook

Bu not, şu anki OpenClaw/ACP davranışına göre **pratik ve bitirilebilir** çalışma kurallarını toplar.
Amacı büyük mimari çözüm değil; kırılgan alanları güvenli kullanıma almak.

## Sonuç özeti

Şu anki ana bulgu:

- gateway genel olarak ayakta ve heartbeat alıyor
- WhatsApp tarafında zaman zaman `status 408` / `stale-socket` reconnect oluyor
- fakat ACP delegated işler için asıl kırılganlık, **session ownership / liveness / finalization** tarafında
- özellikle uzun ve bloklayan ACP işler daha riskli

## Ayrım net olsun

### 1) Gateway genel sağlık

Bunlar iyi durumda olabilir:

- `openclaw gateway status`
- `RPC probe: ok`
- düzenli `web gateway heartbeat`

Bu, ACP delegated session'ların da sağlıklı olduğu anlamına gelmez.

### 2) Kanal (WhatsApp) reconnect gürültüsü

Loglarda görülebilir:

- `status 408`
- `stale-socket`
- otomatik reconnect

Bu ayrı katmandır.
Tek başına ACP failure kök nedeni değildir.

### 3) ACP delegated session kırılganlığı

Asıl kritik sinyaller:

- `queue owner unavailable`
- `ensureSession replacing dead named session`
- `acpx exited with code 1`
- registry'de session var ama transcript artifact eksik / tutarsız

## En güvenli çalışma kuralları

### Kullanılacak mod

- ACP işleri mümkün olduğunca **kısa, bounded ve tek amaçlı** tut
- mümkünse sonucu hızlı üreten görevler ver
- uzun sessiz araştırma işlerini ACP'ye bırakma
- kritik işlerde yalnız session transcript'e güvenme; artifact/log/state de üret

### System event kuralı

ACP/Codex/Gemini içinden:

- `openclaw system event --mode now`
  yerine
- `openclaw system event --mode next-heartbeat`
  kullan

Gerekçe:

- `--mode now` immediate heartbeat tetikliyor
- çağrıyı yapan ACP run bloklanırsa liveliness problemi tetiklenebiliyor
- bu da `1006 abnormal closure` veya session replacement ile sonuçlanabiliyor

## Operasyonel smoke test

Güvenli test:

```bash
openclaw system event --text "gateway stability check" --mode next-heartbeat
```

Beklenen sonuç:

- `ok`
- abnormal closure olmadan temiz dönüş

## Hızlı sağlık kontrolü

```bash
openclaw gateway status
openclaw status --deep
openclaw system heartbeat last
```

Log tarama:

```bash
grep -RIn "queue owner unavailable\|ensureSession replacing dead named session\|abnormal closure\|1006\|acpx exited with code 1\|stale-socket" /tmp/openclaw /home/mertb/.openclaw 2>/dev/null | tail -n 100
```

## Kapanış kriteri

Bu başlık için şimdilik yeterli kabul edilen durum:

- gateway ayakta
- `next-heartbeat` smoke test temiz
- ACP delegated kırılganlık kabul edilip güvenli kullanım kuralları net
- supervisor/result tarafında kritik işlerde artifact üretimi var

## Şimdilik yapılmayacaklar

Bilinçli olarak ertelendi:

- büyük ACP lifecycle refactor
- daemon / watcher karmaşıklığı
- speculative transport rewrite
- gece vakti geniş kapsamlı root-cause reverse engineering

Bu notun amacı çözümü sonsuza kadar ertelemek değil; sistemi **şu andan itibaren güvenli kullanılır** hale getirmek.

### 4) Assistant Operational Protocol for ACP Delegation (Wake-up Mitigation)

Due to the fundamental lack of native background wake-ups on this platform, the Assistant MUST actively mitigate the "wake-up gap" to ensure the user receives final results safely.

**Strategy A (Synchronous - Default):**
Use `scripts/wait_for_acp_job.py` to synchronously block the execution turn and poll the job until completion. Track the job in `acp-ledger.json`. This is the ONLY way to provide a proactive final reply.

**Strategy B (Asynchronous OS Notification - Opt-in):**
For very long tasks where the user explicitly prefers not to wait, spawn the job, record it in the ledger, and start a detached OS background watchdog (`nohup wait_for_acp_job.py --notify --update-ledger &`). This provides an OS notification only. It does NOT wake up the assistant. Warn the user that they must manually reprompt you once they see the desktop OS notification.

For the exact required procedure and the hard truths about unsolved platform gaps, see [acp-orchestration-protocol.md](acp-orchestration-protocol.md).
