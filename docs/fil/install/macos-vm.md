---
summary: "Patakbuhin ang OpenClaw sa isang sandboxed macOS VM (lokal o hosted) kapag kailangan mo ng isolation o iMessage"
read_when:
  - Gusto mo ang OpenClaw na hiwalay sa iyong pangunahing macOS environment
  - Gusto mo ng iMessage integration (BlueBubbles) sa isang sandbox
  - Gusto mo ng resettable na macOS environment na puwede mong i-clone
  - Gusto mong ikumpara ang lokal vs hosted na mga opsyon ng macOS VM
title: "mga macOS VM"
---

# OpenClaw sa macOS VMs (Sandboxing)

## Inirerekomendang default (para sa karamihan ng user)

- **Maliit na Linux VPS** para sa laging-on na Gateway at mababang gastos. Tingnan ang [VPS hosting](/vps).
- **Dedicated hardware** (Mac mini o Linux box) kung gusto mo ng ganap na kontrol at isang **residential IP** para sa browser automation. Maraming site ang nagba-block ng mga data center IP, kaya madalas mas gumagana ang lokal na pagba-browse.
- **Hybrid:** panatilihin ang Gateway sa murang VPS, at ikonekta ang iyong Mac bilang isang **node** kapag kailangan mo ng browser/UI automation. Tingnan ang [Nodes](/nodes) at [Gateway remote](/gateway/remote).

Gumamit ng macOS VM kapag partikular mong kailangan ang macOS-only na kakayahan (iMessage/BlueBubbles) o gusto mo ng mahigpit na isolation mula sa iyong pang-araw-araw na Mac.

## Mga opsyon sa macOS VM

### Lokal na VM sa iyong Apple Silicon Mac (Lume)

Patakbuhin ang OpenClaw sa isang sandboxed macOS VM sa iyong kasalukuyang Apple Silicon Mac gamit ang [Lume](https://cua.ai/docs/lume).

Ibinibigay nito sa iyo ang:

- Buong macOS environment na hiwalay (mananatiling malinis ang iyong host)
- Suporta sa iMessage sa pamamagitan ng BlueBubbles (imposible sa Linux/Windows)
- Agarang reset sa pamamagitan ng pag-clone ng mga VM
- Walang karagdagang hardware o gastos sa cloud

### Mga hosted Mac provider (cloud)

Kung gusto mo ng macOS sa cloud, gumagana rin ang mga hosted Mac provider:

- [MacStadium](https://www.macstadium.com/) (mga hosted Mac)
- Gumagana rin ang ibang hosted Mac vendor; sundin ang kanilang mga doc para sa VM + SSH

Kapag may SSH access ka na sa isang macOS VM, magpatuloy sa hakbang 6 sa ibaba.

---

## Mabilis na ruta (Lume, bihasang user)

1. I-install ang Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Kumpletuhin ang Setup Assistant, i-enable ang Remote Login (SSH)
4. `lume run openclaw --no-display`
5. Mag-SSH, i-install ang OpenClaw, i-configure ang mga channel
6. Tapos

---

## Mga kailangan (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- macOS Sequoia o mas bago sa host
- ~60 GB na libreng disk space bawat VM
- ~20 minuto

---

## 1. I-install ang Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Kung ang `~/.local/bin` ay wala sa iyong PATH:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

I-verify:

```bash
lume --version
```

Docs: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Lumikha ng macOS VM

```bash
lume create openclaw --os macos --ipsw latest
```

I-da-download nito ang macOS at lilikha ng VM. Awtomatikong magbubukas ang isang VNC window.

Tandaan: Maaaring magtagal ang pag-download depende sa iyong koneksyon.

---

## 3. Kumpletuhin ang Setup Assistant

Sa VNC window:

1. Piliin ang wika at rehiyon
2. I-skip ang Apple ID (o mag-sign in kung gusto mo ng iMessage sa kalaunan)
3. Gumawa ng user account (tandaan ang username at password)
4. I-skip ang lahat ng opsyonal na feature

Pagkatapos makumpleto ang setup, i-enable ang SSH:

1. Buksan ang System Settings → General → Sharing
2. I-enable ang "Remote Login"

---

## 4. Kunin ang IP address ng VM

```bash
lume get openclaw
```

Hanapin ang IP address (karaniwan ay `192.168.64.x`).

---

## 5. Mag-SSH papunta sa VM

```bash
ssh youruser@192.168.64.X
```

Palitan ang `youruser` ng account na ginawa mo, at ang IP ng IP ng iyong VM.

---

## 6. I-install ang OpenClaw

Sa loob ng VM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Sundin ang mga onboarding prompt para i-set up ang iyong model provider (Anthropic, OpenAI, atbp.).

---

## 7. I-configure ang mga channel

I-edit ang config file:

```bash
nano ~/.openclaw/openclaw.json
```

Idagdag ang iyong mga channel:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Pagkatapos ay mag-login sa WhatsApp (i-scan ang QR):

```bash
openclaw channels login
```

---

## 8. Patakbuhin ang VM nang headless

Itigil ang VM at i-restart nang walang display:

```bash
lume stop openclaw
lume run openclaw --no-display
```

Tumatakbo ang VM sa background. Pinananatiling tumatakbo ng daemon ng OpenClaw ang gateway.

Para tingnan ang status:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bonus: iMessage integration

Ito ang killer feature ng pagtakbo sa macOS. Gamitin ang [BlueBubbles](https://bluebubbles.app) upang idagdag ang iMessage sa OpenClaw.

Sa loob ng VM:

1. I-download ang BlueBubbles mula sa bluebubbles.app
2. Mag-sign in gamit ang iyong Apple ID
3. I-enable ang Web API at magtakda ng password
4. Ituro ang mga webhook ng BlueBubbles sa iyong gateway (halimbawa: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Idagdag sa iyong OpenClaw config:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

I-restart ang Gateway. Ngayon ay makakapagpadala at makakatanggap na ng iMessages ang iyong agent.

Buong detalye ng setup: [BlueBubbles channel](/channels/bluebubbles)

---

## Mag-save ng golden image

Bago mag-customize pa, i-snapshot ang iyong malinis na estado:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Mag-reset anumang oras:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Pagpapatakbo 24/7

Panatilihing tumatakbo ang VM sa pamamagitan ng:

- Pagpapanatiling naka-plug in ang iyong Mac
- Pag-disable ng sleep sa System Settings → Energy Saver
- Paggamit ng `caffeinate` kung kinakailangan

Para sa tunay na laging-on, isaalang-alang ang isang dedicated Mac mini o isang maliit na VPS. Tingnan ang [VPS hosting](/vps).

---

## Pag-troubleshoot

| Problema                      | Solusyon                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Hindi makapag-SSH sa VM       | Tiyaking naka-enable ang "Remote Login" sa System Settings ng VM                                                |
| Hindi lumalabas ang VM IP     | Hintaying ganap na mag-boot ang VM, patakbuhin muli ang `lume get openclaw`                                     |
| Hindi makita ang Lume command | Idagdag ang `~/.local/bin` sa iyong PATH                                                                        |
| Hindi ma-scan ang WhatsApp QR | Tiyaking naka-login ka sa VM (hindi sa host) kapag pinapatakbo ang `openclaw channels login` |

---

## Kaugnay na docs

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (advanced)
- [Docker Sandboxing](/install/docker) (alternatibong approach sa isolation)
