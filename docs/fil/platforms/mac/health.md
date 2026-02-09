---
summary: "Paano nag-uulat ang macOS app ng mga estado ng kalusugan ng gateway/Baileys"
read_when:
  - Pag-debug ng mga indicator ng kalusugan ng mac app
title: "Mga Health Check"
---

# Mga Health Check sa macOS

Paano makita kung malusog ang naka-link na channel mula sa menu bar app.

## Menu bar

- Ang status dot ay sumasalamin na ngayon sa kalusugan ng Baileys:
  - Berde: naka-link + kamakailang nabuksan ang socket.
  - Kahel: kumokonekta/muling sumusubok.
  - Pula: naka-log out o pumalya ang probe.
- Ipinapakita ng pangalawang linya ang "linked · auth 12m" o ang dahilan ng pagkabigo.
- Ang menu item na "Run Health Check" ay nagti-trigger ng on-demand na probe.

## Settings

- Ang General tab ay may Health card na nagpapakita ng: edad ng linked auth, path/bilang ng session-store, oras ng huling check, huling error/status code, at mga button para sa Run Health Check / Reveal Logs.
- Gumagamit ng cached snapshot para agad mag-load ang UI at maayos na mag-fallback kapag offline.
- Ang **Channels tab** ay nagpapakita ng status ng channel + mga kontrol para sa WhatsApp/Telegram (login QR, logout, probe, huling disconnect/error).

## Paano gumagana ang probe

- Pinapatakbo ng app ang `openclaw health --json` sa pamamagitan ng `ShellExecutor` tuwing ~60s at kapag hinihingi. Ikinakarga ng probe ang mga kredensyal at nag-uulat ng status nang hindi nagpapadala ng mga mensahe.
- I-cache nang hiwalay ang huling magandang snapshot at ang huling error upang maiwasan ang flicker; ipakita ang timestamp ng bawat isa.

## Kapag may alinlangan

- Maaari mo pa ring gamitin ang CLI flow sa [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) at i-tail ang `/tmp/openclaw/openclaw-*.log` para sa `web-heartbeat` / `web-reconnect`.
