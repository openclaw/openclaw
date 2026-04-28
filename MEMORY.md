# MEMORY.md

## Working preferences

- Mert Türkçe konuşulmasını istiyor.
- Ajan hiyerarşisi için doğru kurgu: Lider = Ceviz/OpenClaw base model (subagent değil), ana implementasyon ajanı `gemini_cli`, yardımcı coding lane `codex`, opsiyonel doğrulama modeli Gemini 3.1 Flash; quota varsa yerine yeni doğrulama modeli geçirilmeden bu adım atlanabilir.
- Codex/ACP delegasyonunda yarım durum mesajları yerine sonuca kadar bekleyip, çıktıları okuyup tek mesajda raporlamamı istiyor.
- Mert açıkça blocking/synchronous takip istiyor: agent çalışırken beklemede kalmamı, işi ona geri paslamamamı ve "bekliyor / sen sonra sor" tarzı top atmadan final sonucu dönmemi istiyor.
- Yeni net davranış kuralı: ACP/subagent işi verdiğimde, kullanıcı ara durum istemediyse erken mesaj atıp turn'ü kapatmayacağım; mümkün olan her durumda bağlantıyı/turn'ü açık tutup işler bitene kadar bekleyecek, sonuçları tek final mesajda verip ancak sonra kapanacağım.
- ACP delegasyonlarında final bildirimi yalnızca otomatik completion event'ine bırakılmamalı; daha güvenilir yöntem olarak kalıcı/persistent session + gerektiğinde session history'den sonucu çekme fallback'i kullanılmalı.
- Ürünleşme/doküman akışlarında Mert, her küçük sonraki adım için yeniden onay istemememi; mantıklı sıradaki işe proaktif biçimde devam etmemi istiyor.
- Webchat/direct gibi thread-bound ACP session desteklemeyen yüzeylerde varsayılan ACP politikam: auto completion event'e güvenmeden `sessions_spawn(... mode="run")` sonrası child session'ı explicit history takibiyle izlemek, kullanıcıya ara durum spam'i atmadan mümkünse tek final mesajla dönmek.
- Bu yüzeylerde ACP işi bitince proaktif dönmeyi garantiye yaklaştırmak için default yaklaşımım: childSessionKey sakla, makul aralıklarla `sessions_history` ile completion/failure ara, sonucu sentezle, sonra kullanıcıya tek final mesaj gönder.

## Windows bridge / executor architecture

- Mert'in tercih ettiği model: Ceviz orchestrator/registrator, Windows tarafında ayrı executor agent uygulayıcı olsun.
- Bu model uygulanabilir; uzak Azure VM zorunlu değil.
- Doğru teknik yön:
  - sandboxed lane: Linux/WSL planning ve workspace işleri
  - escalated Windows-capable lane: `cmd.exe`, `pwsh.exe`, `dotnet.exe`, browser launch, Windows-side artifact üretimi
- Asıl kritik bulgu: sorun global olarak "Windows interop bozuk" değil; execution lane'e göre davranış değişiyor.
- Approval-heavy Windows görevleri unattended automation için riskli olabilir.

## Current project state (2026-03-30)

- ACP/Codex delegasyonu başlangıçta çalışmıyordu; neden `acpx` runtime plugin disabled idi. Enable edilip gateway restart sonrası düzeldi.
- `TOOLS.md` içine Windows host access köprüleri eklendi (`pwsh`, `dotnet`, `browser-launch`, `/mnt/c`).
- Windows bridge bootstrap Phase 1 tamamlandı:
  - `windows-bridge-bootstrap.md`
  - `windows-bridge-bootstrap/` scaffold
  - `scripts/win-capability-probe.ps1`
  - probe ve future bridge notes
- Phase 2 başlangıcı tamamlandı:
  - `windows-bridge-phase2.md`
  - Windows capability probe başarıyla Windows PowerShell 7 üzerinden çalıştırıldı
  - gerçek JSON artifact üretildi ve WSL'den doğrulandı
  - dotnet erişimi doğrulandı (`dotnetVersion: 10.0.103`)
  - queue skeleton oluşturuldu (`inbound/outbound/archive`)
- Sonraki önerilen adım: minimal queue-driven Windows helper runner (Phase 3).
- Daha sonra Phase 3-5 tamamlandı: queue-driven Windows helper runner, WSL enqueue/wait wrapper ve tek komutluk request/response bridge başarıyla çalıştırılıp doğrulandı.
- Phase 6 mail erişiminde Outlook COM bu makinede uygun çıkmadı; Microsoft Graph yönüne dönüldü.
- Microsoft.Graph PowerShell auth güvenilir davranmayınca auth katmanı MSAL + doğrudan Graph REST yoluna çevrildi.
- MSAL device flow ile `mertbasar0@hotmail.com` hesabında başarılı login alındı ve Graph REST üzerinden mailbox taraması çalıştırıldı.
- Derin taramada paging ile 25 sayfa / 5000 mail tarandı; öne çıkan anlamlı kayıtlar arasında Wipro recruiter outreach, KoçDigital application link ve Turkish Technology süreç mailleri var.
- Yeni hedef yön: mimarlık/mühendislik çizim programları kullanan profesyonellere asistanlık edecek CAD/BIM copilot benzeri yapı. İlk doğru yaklaşım: read-only analiz + tavsiye, sonra onaylı düzenleme; muhtemel mimari: plugin/add-in + local Windows bridge/executor + Ceviz orchestrator + rules layer.

## Watch Ceviz State (2026-04-21)

- V1 Developer / Operator Pack "Must-have" özellikleri için altyapı güncellendi.
- Backend: Dinamik `report_sections` üretimi için tek noktadan (single-source) inşa yapısı eklendi. Kontrat şemalarına (JSON) detaylı hata takibi için `retry_count`, `failure_code`, `failure_message` eklendi. Testler (21/21) geçiyor.
- Client (Swift/iOS/Watch): Modeller yeni metadatayı okuyacak şekilde güncellendi. UI üzerinde `ReportSectionCard` oluşturuldu ve Job detaylarına bağlandı.
- Çevrimdışı Dayanıklılık (Offline Resilience): `WatchSessionManager` içerisine bağlantı durumunu izleyen `reachability` takibi ve bağlantı koptuğunda komutları kaybetmemesi için `pendingCommands` isimli kuyruğa (queued retry) alma sistemi kuruldu.
- Cloud Build: XcodeGen kullanılarak `.xcodeproj` bulutta dinamik oluşturuldu. GitHub Actions üzerinden fiziksel cihaz hedeflenerek imzasız `.ipa` (CevizWatch.ipa) başarıyla dışarı aktarıldı (Sideloadly kurulumu için hazır).
- **Sonraki Adım:** Sideloadly ile cihaza kurulum ve bilekten canlı saha testi (Live Testing: Deploy, PR Review, Incident Triage).
