# OpenClaw Vesicle Channel

Vesicle is an OpenClaw channel plugin for sending and receiving iMessage traffic through the Vesicle native macOS bridge.

## Install

From a local checkout:

```sh
openclaw plugins install -l ./extensions/vesicle
```

From a packed tarball:

```sh
openclaw plugins install ./openclaw-vesicle-2026.4.25.tgz
```

Configure the channel under `channels.vesicle`:

```json5
{
  channels: {
    vesicle: {
      enabled: true,
      serverUrl: "http://127.0.0.1:1234",
      authToken: "vesicle-auth-token",
      webhookSecret: "shared-webhook-secret",
    },
  },
}
```

The default webhook path is `/vesicle-webhook`.
