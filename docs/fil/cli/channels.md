---
summary: "CLI reference para sa `openclaw channels` (mga account, status, login/logout, mga log)"
read_when:
  - Gusto mong magdagdag/mag-alis ng mga channel account (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - Gusto mong tingnan ang status ng channel o mag-tail ng mga log ng channel
title: "channels"
x-i18n:
  source_path: cli/channels.md
  source_hash: 16ab1642f247bfa9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:22Z
---

# `openclaw channels`

Pamahalaan ang mga chat channel account at ang kanilang runtime status sa Gateway.

Kaugnay na docs:

- Mga gabay sa channel: [Channels](/channels/index)
- Konpigurasyon ng Gateway: [Configuration](/gateway/configuration)

## Mga karaniwang command

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Magdagdag / mag-alis ng mga account

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Tip: ipinapakita ng `openclaw channels add --help` ang mga flag kada channel (token, app token, mga path ng signal-cli, atbp).

## Mag-login / mag-logout (interactive)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Pag-troubleshoot

- Patakbuhin ang `openclaw status --deep` para sa malawak na probe.
- Gamitin ang `openclaw doctor` para sa guided na mga ayos.
- Ipiniprint ng `openclaw channels list` ang `Claude: HTTP 403 ... user:profile` → ang snapshot ng paggamit ay nangangailangan ng `user:profile` scope. Gamitin ang `--no-usage`, o magbigay ng claude.ai session key (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), o mag-re-auth sa pamamagitan ng Claude Code CLI.

## Probe ng mga kakayahan

Kunin ang mga hint ng kakayahan ng provider (mga intent/scope kung available) kasama ang static na suporta sa feature:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Mga tala:

- Opsyonal ang `--channel`; alisin ito para ilista ang bawat channel (kasama ang mga extension).
- Tumatanggap ang `--target` ng `channel:<id>` o ng raw na numeric channel id at nalalapat lamang sa Discord.
- Provider-specific ang mga probe: Discord intents + opsyonal na mga permiso ng channel; Slack bot + user scopes; Telegram bot flags + webhook; bersyon ng Signal daemon; MS Teams app token + Graph roles/scopes (may anotasyon kung saan alam). Ang mga channel na walang probe ay nag-uulat ng `Probe: unavailable`.

## I-resolve ang mga pangalan sa mga ID

I-resolve ang mga pangalan ng channel/user sa mga ID gamit ang provider directory:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Mga tala:

- Gamitin ang `--kind user|group|auto` para pilitin ang target type.
- Mas pinipili ng resolution ang mga aktibong tugma kapag maraming entry ang may parehong pangalan.
