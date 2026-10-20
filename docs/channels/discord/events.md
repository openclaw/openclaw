---
summary: "Reaction notifications, presence events and configuration, config writes, proxying, and PluralKit"
read_when:
  - Waking an agent on Discord reactions or presence changes
  - Setting bot presence, a gateway proxy, or PluralKit support
title: "Discord events and operations"
sidebarTitle: "Events and operations"
---

Operational Discord surfaces: reaction and presence wakes, bot presence, gateway proxying, config writes, and PluralKit.

## Events and operations

<AccordionGroup>
  <Accordion title="Reaction notifications">
    Per-guild reaction notification mode (`guilds.<id>.reactionNotifications`):

    - `off`
    - `own` (default)
    - `all`
    - `allowlist` (uses `guilds.<id>.users`)

    Reaction events are turned into system events and attached to the routed Discord session.

  </Accordion>

  <Accordion title="Online presence events">
    Opt a guild into routed agent wakes when a human member transitions from offline to online:

    ```json5
    {
      channels: {
        discord: {
          intents: { presence: true },
          guilds: {
            "111111111111111111": {
              presenceEvents: {
                channelId: "222222222222222222",
                users: ["333333333333333333"], // optional; further narrow channel viewers
                reconnectSuppressSeconds: 300, // optional; new-session quiet window (0 disables)
                burstLimit: 8, // optional; max events per burst window
                burstWindowSeconds: 60, // optional; sliding burst-detection window
              },
            },
          },
        },
      },
    }
    ```

    `presenceEvents` requires an enabled heartbeat for the routed agent and the privileged **Presence Intent** on the application's Bot page in the Discord Developer Portal. OpenClaw seeds current online members from each complete `GUILD_CREATE` snapshot, routes observed offline-to-online transitions, and also treats a later first online signal for an unseen member as newly available. That member may have come online or joined after the snapshot, so the event does not assert an exact prior status. Only humans who can view `channelId` are eligible: channels and public threads require **View Channel** on the channel or parent, while private threads additionally require membership or **Manage Threads**. `users` can further narrow that audience. OpenClaw ignores bots and unchanged online states and persists an eight-hour per-user cooldown across Gateway restarts. When Discord establishes a new Gateway session and sends `READY`, OpenClaw suppresses presence-derived events for `reconnectSuppressSeconds` (default 300, `0` disables) while guild presence state is rebuilt, so re-observed members cannot wake the agent one by one. It additionally rate-limits successfully queued events per guild to `burstLimit` events (default 8) per `burstWindowSeconds` sliding window (default 60), logging each guild's suppression episode once. A resumed session is not treated as a new session. Discord limits snapshots for guilds above 75,000 members; there, OpenClaw requires an explicit offline update before greeting. The system event carries immutable user, guild, and channel IDs without embedding mutable display names. The agent decides whether and how to greet.

  </Accordion>

  <Accordion title="Presence configuration">
    Presence updates are applied when you set a status or activity field, or when you enable auto presence.

    Status only:

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

    Activity (custom status is the default activity type when `activity` is set):

```json5
{
  channels: {
    discord: {
      activity: "Focus time",
      activityType: 4,
    },
  },
}
```

    Streaming:

```json5
{
  channels: {
    discord: {
      activity: "Live coding",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    },
  },
}
```

    Activity type map:

    - 0: Playing
    - 1: Streaming (requires `activityUrl`; `activityUrl` in turn requires `activityType: 1`)
    - 2: Listening
    - 3: Watching
    - 4: Custom (uses the activity text as the status state; emoji is optional)
    - 5: Competing

    Auto presence (runtime health signal):

```json5
{
  channels: {
    discord: {
      autoPresence: {
        enabled: true,
        intervalMs: 30000,
        minUpdateIntervalMs: 15000,
      },
    },
  },
}
```

    Auto presence maps runtime availability to Discord status: healthy => online, degraded or unknown => idle, exhausted or unavailable => dnd. Defaults: `intervalMs` 30000, `minUpdateIntervalMs` 15000 (must be less than or equal to `intervalMs`).

  </Accordion>

  <Accordion title="Config writes">
    Channel-initiated config writes are enabled by default. This affects `/config set|unset` flows (when command features are enabled).

    Disable:

```json5
{
  channels: {
    discord: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Gateway proxy">
    Route Discord gateway WebSocket traffic and startup REST lookups (application ID + allowlist resolution) through an HTTP(S) proxy with `channels.discord.proxy`.
    Discord gateway WebSocket proxying is explicit; WebSocket connections do not inherit ambient proxy environment variables from the Gateway process. Startup REST lookups use this proxy when `channels.discord.proxy` is configured.

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    Per-account override:

```json5
{
  channels: {
    discord: {
      accounts: {
        primary: {
          proxy: "http://proxy.example:8080",
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="PluralKit support">
    Enable PluralKit resolution to map proxied messages to system member identity:

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; needed for private systems
      },
    },
  },
}
```

    Notes:

    - allowlists can use `pk:<memberId>`
    - member display names are matched by name/slug only when `channels.discord.dangerouslyAllowNameMatching: true`
    - lookups query the PluralKit API with the original message ID
    - if lookup fails, proxied messages are treated as bot messages and dropped unless `allowBots` lets them through

  </Accordion>
</AccordionGroup>
