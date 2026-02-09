---
summary: "Katayuan ng suporta, mga kakayahan, at konpigurasyon ng Nextcloud Talk"
read_when:
  - Nagtatrabaho sa mga feature ng channel ng Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (plugin)

10. Status: sinusuportahan sa pamamagitan ng plugin (webhook bot). 11. Sinusuportahan ang direct messages, rooms, reactions, at markdown messages.

## Kailangan ang plugin

Ipinapadala ang Nextcloud Talk bilang plugin at hindi kasama sa core install.

I-install sa pamamagitan ng CLI (npm registry):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Local checkout (kapag tumatakbo mula sa isang git repo):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Kung pipiliin mo ang Nextcloud Talk sa panahon ng configure/onboarding at may natukoy na git checkout,
awtomatikong iaalok ng OpenClaw ang lokal na install path.

Mga detalye: [Plugins](/tools/plugin)

## Mabilis na setup (baguhan)

1. I-install ang Nextcloud Talk plugin.

2. Sa iyong Nextcloud server, gumawa ng bot:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. I-enable ang bot sa mga setting ng target room.

4. I-configure ang OpenClaw:
   - Config: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - O env: `NEXTCLOUD_TALK_BOT_SECRET` (default account lamang)

5. I-restart ang Gateway (o tapusin ang onboarding).

Minimal na config:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Mga tala

- 12. Hindi maaaring magpasimula ng DM ang mga bot. 13. Kailangang ang user ang unang mag-message sa bot.
- Dapat maabot ng Gateway ang webhook URL; itakda ang `webhookPublicUrl` kung nasa likod ng proxy.
- Hindi suportado ng bot API ang media uploads; ipinapadala ang media bilang mga URL.
- Hindi tinutukoy ng webhook payload kung DM o room; itakda ang `apiUser` + `apiPassword` para paganahin ang mga lookup ng uri ng room (kung hindi, ituturing ang DMs bilang rooms).

## Kontrol sa access (DMs)

- Default: `channels.nextcloud-talk.dmPolicy = "pairing"`. 14. Ang mga hindi kilalang sender ay nakakakuha ng pairing code.
- I-apruba sa pamamagitan ng:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Pampublikong DMs: `channels.nextcloud-talk.dmPolicy="open"` kasama ang `channels.nextcloud-talk.allowFrom=["*"]`.
- Ang `allowFrom` ay tumutugma lamang sa mga Nextcloud user ID; binabalewala ang mga display name.

## Mga room (grupo)

- Default: `channels.nextcloud-talk.groupPolicy = "allowlist"` (mention-gated).
- I-allowlist ang mga room gamit ang `channels.nextcloud-talk.rooms`:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- Para huwag payagan ang anumang room, panatilihing walang laman ang allowlist o itakda ang `channels.nextcloud-talk.groupPolicy="disabled"`.

## Mga kakayahan

| Feature         | Katayuan        |
| --------------- | --------------- |
| Direct messages | Sinusuportahan  |
| Rooms           | Sinusuportahan  |
| Threads         | Hindi suportado |
| Media           | URL-only        |
| Reactions       | Sinusuportahan  |
| Native commands | Hindi suportado |

## Sanggunian sa konpigurasyon (Nextcloud Talk)

Buong konpigurasyon: [Configuration](/gateway/configuration)

Mga opsyon ng provider:

- `channels.nextcloud-talk.enabled`: i-enable/i-disable ang pagsisimula ng channel.
- `channels.nextcloud-talk.baseUrl`: URL ng Nextcloud instance.
- `channels.nextcloud-talk.botSecret`: shared secret ng bot.
- `channels.nextcloud-talk.botSecretFile`: path ng secret file.
- `channels.nextcloud-talk.apiUser`: API user para sa mga lookup ng room (DM detection).
- `channels.nextcloud-talk.apiPassword`: API/app password para sa mga lookup ng room.
- `channels.nextcloud-talk.apiPasswordFile`: path ng API password file.
- `channels.nextcloud-talk.webhookPort`: port ng webhook listener (default: 8788).
- `channels.nextcloud-talk.webhookHost`: webhook host (default: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: webhook path (default: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: externally reachable na webhook URL.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- 15. `channels.nextcloud-talk.allowFrom`: DM allowlist (mga user ID). 16. Ang `open` ay nangangailangan ng `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: group allowlist (mga user ID).
- `channels.nextcloud-talk.rooms`: mga per-room setting at allowlist.
- `channels.nextcloud-talk.historyLimit`: limit ng history ng group (0 ay nagdi-disable).
- `channels.nextcloud-talk.dmHistoryLimit`: limit ng history ng DM (0 ay nagdi-disable).
- `channels.nextcloud-talk.dms`: mga per-DM override (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: laki ng outbound text chunk (chars).
- `channels.nextcloud-talk.chunkMode`: `length` (default) o `newline` para hatiin sa mga blank line (mga hangganan ng talata) bago ang length chunking.
- `channels.nextcloud-talk.blockStreaming`: i-disable ang block streaming para sa channel na ito.
- `channels.nextcloud-talk.blockStreamingCoalesce`: tuning ng block streaming coalesce.
- `channels.nextcloud-talk.mediaMaxMb`: inbound media cap (MB).
