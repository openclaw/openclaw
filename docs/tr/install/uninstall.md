---
summary: "OpenClaw'ı tamamen kaldırın (CLI, servis, durum, çalışma alanı)"
read_when:
  - Bir makineden OpenClaw'ı kaldırmak istiyorsunuz
  - Kaldırma işleminden sonra gateway servisi hâlâ çalışıyor
title: "Kaldırma"
---

# Kaldırma

İki yol vardır:

- **Kolay yol**: `openclaw` hâlâ yüklüyse.
- **Manuel servis kaldırma**: CLI yoksa ancak servis hâlâ çalışıyorsa.

## Kolay yol (CLI hâlâ yüklü)

Önerilen: yerleşik kaldırıcıyı kullanın:

```bash
openclaw uninstall
```

Etkileşimsiz (otomasyon / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Manuel adımlar (aynı sonucu verir):

1. Gateway servisini durdurun:

```bash
openclaw gateway stop
```

2. Gateway servisini kaldırın (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Durum + yapılandırmayı silin:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

`OPENCLAW_CONFIG_PATH` değerini durum dizini dışında özel bir konuma ayarladıysanız, o dosyayı da silin.

4. Çalışma alanınızı silin (isteğe bağlı, ajan dosyalarını kaldırır):

```bash
rm -rf ~/.openclaw/workspace
```

5. CLI kurulumunu kaldırın (kullandığınız yöntemi seçin):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. macOS uygulamasını yüklediyseniz:

```bash
rm -rf /Applications/OpenClaw.app
```

Notlar:

- Profiller kullandıysanız (`--profile` / `OPENCLAW_PROFILE`), her durum dizini için 3. adımı tekrarlayın (varsayılanlar `~/.openclaw-<profile>`).
- Uzak modda, durum dizini **gateway ana makinesi** üzerinde bulunur; bu nedenle 1-4. adımları orada da çalıştırın.

## Manuel servis kaldırma (CLI yüklü değil)

Gateway servisi çalışmaya devam ediyorsa ancak `openclaw` yoksa bunu kullanın.

### macOS (launchd)

Varsayılan etiket `bot.molt.gateway`'dir (veya `bot.molt.<profile>`; eski `com.openclaw.*` hâlâ mevcut olabilir):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Bir profil kullandıysanız, etiketi ve plist adını `bot.molt.<profile>` ile değiştirin. Mevcutsa eski `com.openclaw.*` plist'lerini kaldırın.

### Linux (systemd kullanıcı birimi)

Varsayılan birim adı `openclaw-gateway.service`'dir (veya `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Zamanlanmış Görev)

Varsayılan görev adı `OpenClaw Gateway`'tür (veya `OpenClaw Gateway (<profile>)`).
Görev betiği durum dizininizin altında bulunur.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Bir profil kullandıysanız, eşleşen görev adını ve `~\.openclaw-<profile>\gateway.cmd` öğesini silin.

## Normal install vs source checkout

### Normal kurulum (install.sh / npm / pnpm / bun)

`https://openclaw.ai/install.sh` veya `install.ps1` kullandıysanız, CLI `npm install -g openclaw@latest` ile kurulmuştur.
`npm rm -g openclaw` ile kaldırın (veya o şekilde kurduysanız `pnpm remove -g` / `bun remove -g`).

### Kaynak kodu ile kurulum (git clone)

Bir depo kopyasından çalıştırıyorsanız (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Depoyu silmeden **önce** gateway servisini kaldırın (yukarıdaki kolay yolu veya manuel servis kaldırmayı kullanın).
2. Delete the repo directory.
3. Yukarıda gösterildiği gibi durum + çalışma alanını kaldırın.
