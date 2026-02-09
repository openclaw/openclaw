---
summary: "Suporta para sa personal na Zalo account sa pamamagitan ng zca-cli (QR login), mga kakayahan, at konpigurasyon"
read_when:
  - Pagse-setup ng Zalo Personal para sa OpenClaw
  - Pag-debug ng Zalo Personal login o daloy ng mensahe
title: "Zalo Personal"
---

# Zalo Personal (hindi opisyal)

4. Status: eksperimental. 5. Ang integration na ito ay nag-a-automate ng isang **personal na Zalo account** gamit ang `zca-cli`.

> 6. **Babala:** Ito ay isang hindi opisyal na integration at maaaring magresulta sa suspensyon/pag-ban ng account. 7. Gamitin sa sarili mong panganib.

## Kailangan na plugin

Ang Zalo Personal ay ipinapadala bilang isang plugin at hindi kasama sa core install.

- I-install sa pamamagitan ng CLI: `openclaw plugins install @openclaw/zalouser`
- O mula sa isang source checkout: `openclaw plugins install ./extensions/zalouser`
- Mga detalye: [Plugins](/tools/plugin)

## Paunang kinakailangan: zca-cli

Dapat mayroong `zca` binary ang Gateway machine na available sa `PATH`.

- I-verify: `zca --version`
- Kung wala, i-install ang zca-cli (tingnan ang `extensions/zalouser/README.md` o ang upstream zca-cli docs).

## Mabilis na setup (baguhan)

1. I-install ang plugin (tingnan sa itaas).
2. Mag-login (QR, sa Gateway machine):
   - `openclaw channels login --channel zalouser`
   - I-scan ang QR code sa terminal gamit ang Zalo mobile app.
3. I-enable ang channel:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. I-restart ang Gateway (o tapusin ang onboarding).
5. Ang DM access ay default sa pairing; aprubahan ang pairing code sa unang pakikipag-ugnayan.

## Ano ito

- Gumagamit ng `zca listen` para tumanggap ng mga papasok na mensahe.
- Gumagamit ng `zca msg ...` para magpadala ng mga reply (text/media/link).
- Dinisenyo para sa mga use case ng “personal account” kung saan hindi available ang Zalo Bot API.

## Pagpapangalan

8. Ang Channel id ay `zalouser` upang malinaw na ipakita na ito ay nag-a-automate ng isang **personal na Zalo user account** (hindi opisyal). 9. Inilalaan namin ang `zalo` para sa isang posibleng opisyal na Zalo API integration sa hinaharap.

## Paghahanap ng mga ID (directory)

Gamitin ang directory CLI upang matuklasan ang mga peer/group at ang kanilang mga ID:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Mga limitasyon

- Ang outbound text ay hinahati sa ~2000 character (mga limitasyon ng Zalo client).
- Naka-block ang streaming bilang default.

## Kontrol sa access (DMs)

10. Sinusuportahan ng `channels.zalouser.dmPolicy` ang: `pairing | allowlist | open | disabled` (default: `pairing`).
11. Tumatanggap ang `channels.zalouser.allowFrom` ng mga user ID o pangalan. 12. Nireresolba ng wizard ang mga pangalan patungo sa mga ID sa pamamagitan ng `zca friend find` kapag available.

Aprubahan sa pamamagitan ng:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Access sa grupo (opsyonal)

- 13. Default: `channels.zalouser.groupPolicy = "open"` (pinapayagan ang mga grupo). 14. Gamitin ang `channels.defaults.groupPolicy` upang i-override ang default kapag hindi naka-set.
- I-restrict sa isang allowlist gamit ang:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (ang mga key ay mga group ID o pangalan)
- I-block ang lahat ng grupo: `channels.zalouser.groupPolicy = "disabled"`.
- Maaaring mag-prompt ang configure wizard para sa mga group allowlist.
- Sa startup, nireresolba ng OpenClaw ang mga pangalan ng grupo/user sa mga allowlist tungo sa mga ID at inilolog ang mapping; ang mga hindi maresolbang entry ay pinananatili ayon sa pagkaka-type.

Halimbawa:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Maramihang account

15. Ang mga account ay naka-map sa mga zca profile. Halimbawa:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Pag-troubleshoot

**Hindi makita ang `zca`:**

- I-install ang zca-cli at tiyaking nasa `PATH` ito para sa proseso ng Gateway.

**Hindi nananatili ang login:**

- `openclaw channels status --probe`
- Mag-login muli: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
