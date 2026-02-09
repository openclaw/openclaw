---
summary: "Katayuan ng suporta sa Matrix, mga kakayahan, at konpigurasyon"
read_when:
  - Nagtatrabaho sa mga feature ng Matrix channel
title: "Matrix"
---

# Matrix (plugin)

Matrix is an open, decentralized messaging protocol. OpenClaw connects as a Matrix **user**
on any homeserver, so you need a Matrix account for the bot. Kapag ito ay naka-log in na, maaari mo itong i-DM
direkta o imbitahan sa mga room (Matrix "groups"). Beeper is a valid client option too,
but it requires E2EE to be enabled.

Status: supported via plugin (@vector-im/matrix-bot-sdk). Direct messages, rooms, threads, media, reactions,
polls (send + poll-start as text), location, and E2EE (with crypto support).

## Kinakailangang plugin

Ipinapadala ang Matrix bilang plugin at hindi kasama sa core install.

I-install sa pamamagitan ng CLI (npm registry):

```bash
openclaw plugins install @openclaw/matrix
```

Local checkout (kapag tumatakbo mula sa git repo):

```bash
openclaw plugins install ./extensions/matrix
```

Kung pipiliin mo ang Matrix sa panahon ng configure/onboarding at may na-detect na git checkout,
awtomatikong iaalok ng OpenClaw ang local install path.

Mga detalye: [Plugins](/tools/plugin)

## Setup

1. I-install ang Matrix plugin:
   - Mula sa npm: `openclaw plugins install @openclaw/matrix`
   - Mula sa local checkout: `openclaw plugins install ./extensions/matrix`

2. Gumawa ng Matrix account sa isang homeserver:
   - Tingnan ang mga hosting option sa [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - O i-host mo ito mismo.

3. Kumuha ng access token para sa bot account:

   - Gamitin ang Matrix login API gamit ang `curl` sa iyong homeserver:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - Palitan ang `matrix.example.org` ng URL ng iyong homeserver.
   - O itakda ang `channels.matrix.userId` + `channels.matrix.password`: tatawag ang OpenClaw sa parehong
     login endpoint, ise-save ang access token sa `~/.openclaw/credentials/matrix/credentials.json`,
     at gagamitin muli ito sa susunod na start.

4. I-configure ang credentials:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (o `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - O config: `channels.matrix.*`
   - Kung parehong naka-set, mas may prioridad ang config.
   - Kapag may access token: awtomatikong kinukuha ang user ID sa pamamagitan ng `/whoami`.
   - Kapag naka-set, ang `channels.matrix.userId` ay dapat ang buong Matrix ID (halimbawa: `@bot:example.org`).

5. I-restart ang Gateway (o tapusin ang onboarding).

6. Start a DM with the bot or invite it to a room from any Matrix client
   (Element, Beeper, etc.; see [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). Nangangailangan ang Beeper ng E2EE,
   kaya itakda ang `channels.matrix.encryption: true` at i-verify ang device.

Minimal na config (access token, awtomatikong kinukuha ang user ID):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

Config para sa E2EE (end-to-end encryption na naka-enable):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Encryption (E2EE)

Ang end-to-end encryption ay **suportado** sa pamamagitan ng Rust crypto SDK.

I-enable gamit ang `channels.matrix.encryption: true`:

- Kapag nag-load ang crypto module, awtomatikong nade-decrypt ang mga encrypted room.
- Ang outbound media ay naka-encrypt kapag nagpapadala sa mga encrypted room.
- Sa unang koneksyon, humihiling ang OpenClaw ng device verification mula sa iyong iba pang session.
- Verify the device in another Matrix client (Element, etc.) upang i-enable ang key sharing.
- Kapag hindi ma-load ang crypto module, madi-disable ang E2EE at hindi ma-decrypt ang mga encrypted room;
  maglo-log ang OpenClaw ng babala.
- Kung makakita ka ng mga error tungkol sa nawawalang crypto module (halimbawa, `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  payagan ang mga build script para sa `@matrix-org/matrix-sdk-crypto-nodejs` at patakbuhin ang
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` o kunin ang binary gamit ang
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

Ang crypto state ay iniimbak per account + access token sa
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite database). Sync state lives alongside it in `bot-storage.json`.
If the access token (device) changes, a new store is created and the bot must be
re-verified for encrypted rooms.

**Device verification:**
Kapag naka-enable ang E2EE, hihiling ang bot ng verification mula sa iyong iba pang session sa startup.
Buksan ang Element (o ibang client) at aprubahan ang verification request upang magtatag ng tiwala.
Kapag na-verify na, kayang i-decrypt ng bot ang mga mensahe sa mga encrypted room.

## Routing model

- Ang mga reply ay palaging bumabalik sa Matrix.
- Ang mga DM ay nagbabahagi ng pangunahing session ng agent; ang mga room ay tumutugma sa mga group session.

## Kontrol sa access (DMs)

- Default: `channels.matrix.dm.policy = "pairing"`. Unknown senders get a pairing code.
- Aprubahan sa pamamagitan ng:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- Mga public DM: `channels.matrix.dm.policy="open"` kasama ang `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` ay tumatanggap ng buong Matrix user ID (halimbawa: `@user:server`). Nire-resolve ng wizard ang mga display name tungo sa mga user ID kapag ang directory search ay nakahanap ng iisang eksaktong tugma.

## Mga room (groups)

- Default: `channels.matrix.groupPolicy = "allowlist"` (mention-gated). Use `channels.defaults.groupPolicy` to override the default when unset.
- I-allowlist ang mga room gamit ang `channels.matrix.groups` (mga room ID o alias; nireresolba ang mga pangalan patungo sa ID kapag ang directory search ay nakahanap ng iisang eksaktong tugma):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- Pinapagana ng `requireMention: false` ang auto-reply sa room na iyon.
- Maaaring magtakda ang `groups."*"` ng mga default para sa mention gating sa lahat ng room.
- Nililimitahan ng `groupAllowFrom` kung aling mga sender ang maaaring mag-trigger ng bot sa mga room (buong Matrix user ID).
- Ang per-room na `users` na mga allowlist ay maaaring higit pang maghigpit sa mga sender sa loob ng isang partikular na room (gamitin ang buong Matrix user ID).
- Hihingi ang configure wizard ng mga room allowlist (mga room ID, alias, o pangalan) at nireresolba lamang ang mga pangalan kapag eksakto at natatangi ang tugma.
- Sa startup, nireresolba ng OpenClaw ang mga pangalan ng room/user sa mga allowlist patungo sa mga ID at nilolog ang mapping; ang mga hindi maresolbang entry ay binabalewala para sa allowlist matching.
- Ang mga imbitasyon ay awtomatikong ina-join bilang default; kontrolin gamit ang `channels.matrix.autoJoin` at `channels.matrix.autoJoinAllowlist`.
- Para **walang room**, itakda ang `channels.matrix.groupPolicy: "disabled"` (o panatilihing walang laman ang allowlist).
- Legacy key: `channels.matrix.rooms` (kaparehong hugis ng `groups`).

## Threads

- Suportado ang reply threading.
- Kinokontrol ng `channels.matrix.threadReplies` kung mananatili sa thread ang mga reply:
  - `off`, `inbound` (default), `always`
- Kinokontrol ng `channels.matrix.replyToMode` ang reply-to metadata kapag hindi nagre-reply sa thread:
  - `off` (default), `first`, `all`

## Mga kakayahan

| Feature         | Katayuan                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Direct messages | ✅ Supported                                                                                                                  |
| Rooms           | ✅ Supported                                                                                                                  |
| Threads         | ✅ Supported                                                                                                                  |
| Media           | ✅ Supported                                                                                                                  |
| E2EE            | ✅ Supported (kinakailangan ang crypto module)                                                             |
| Reactions       | ✅ Supported (send/read sa pamamagitan ng tools)                                                           |
| Polls           | ✅ Suportado ang send; ang mga inbound poll start ay kino-convert sa text (binale-wala ang responses/ends) |
| Location        | ✅ Supported (geo URI; binale-wala ang altitude)                                                           |
| Native commands | ✅ Supported                                                                                                                  |

## Pag-troubleshoot

Patakbuhin muna ang ladder na ito:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Pagkatapos, kumpirmahin ang DM pairing state kung kinakailangan:

```bash
openclaw pairing list matrix
```

Mga karaniwang failure:

- Naka-log in ngunit binabalewala ang mga mensahe sa room: naka-block ang room ng `groupPolicy` o ng room allowlist.
- Binabalewala ang mga DM: nakabinbin ang pag-apruba ng sender kapag `channels.matrix.dm.policy="pairing"`.
- Pumapalya ang mga encrypted room: hindi tugma ang crypto support o mga setting ng encryption.

Para sa triage flow: [/channels/troubleshooting](/channels/troubleshooting).

## Sanggunian sa konpigurasyon (Matrix)

Buong konpigurasyon: [Configuration](/gateway/configuration)

Mga opsyon ng provider:

- `channels.matrix.enabled`: i-enable/i-disable ang startup ng channel.
- `channels.matrix.homeserver`: URL ng homeserver.
- `channels.matrix.userId`: Matrix user ID (opsyonal kapag may access token).
- `channels.matrix.accessToken`: access token.
- `channels.matrix.password`: password para sa login (iniimbak ang token).
- `channels.matrix.deviceName`: display name ng device.
- `channels.matrix.encryption`: i-enable ang E2EE (default: false).
- `channels.matrix.initialSyncLimit`: initial sync limit.
- `channels.matrix.threadReplies`: `off | inbound | always` (default: inbound).
- `channels.matrix.textChunkLimit`: laki ng outbound text chunk (chars).
- `channels.matrix.chunkMode`: `length` (default) o `newline` para hatiin sa mga blankong linya (mga hangganan ng talata) bago ang length chunking.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.matrix.dm.allowFrom`: DM allowlist (full Matrix user IDs). `open` requires `"*"`. The wizard resolves names to IDs when possible.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (default: allowlist).
- `channels.matrix.groupAllowFrom`: mga allowlisted sender para sa group messages (buong Matrix user ID).
- `channels.matrix.allowlistOnly`: ipilit ang mga panuntunan ng allowlist para sa mga DM + room.
- `channels.matrix.groups`: group allowlist + per-room na settings map.
- `channels.matrix.rooms`: legacy na group allowlist/config.
- `channels.matrix.replyToMode`: reply-to mode para sa threads/tags.
- `channels.matrix.mediaMaxMb`: inbound/outbound media cap (MB).
- `channels.matrix.autoJoin`: paghawak ng imbitasyon (`always | allowlist | off`, default: always).
- `channels.matrix.autoJoinAllowlist`: mga pinapayagang room ID/alias para sa auto-join.
- `channels.matrix.actions`: per-action tool gating (reactions/messages/pins/memberInfo/channelInfo).
