# Google Keep (OpenClaw plugin)

Reads unchecked items from a shared Google Keep list note via a persistent Playwright browser session.

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
openclaw plugins enable google-keep
```

Restart the Gateway after enabling.

## Sign in

Open a browser window to authenticate with your Google account:

```bash
/keep login
```

The window closes automatically once sign-in completes. Your session is saved to disk and reused across Gateway restarts — you only need to log in once.

Check whether a saved session exists:

```bash
/keep status
```

## Configure

Add to your `openclaw.json` under `plugins.google-keep`:

```json
{
  "plugins": {
    "google-keep": {
      "listUrl": "https://keep.google.com/#NOTE_ID",
      "timeoutMs": 15000
    }
  }
}
```

| Option       | Type     | Default                                   | Description                                                                 |
| ------------ | -------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `listUrl`    | `string` | —                                         | Default note URL used when the tool is called without a `listUrl` parameter |
| `profileDir` | `string` | `~/.openclaw/plugins/google-keep/profile` | Override path for the Playwright browser profile                            |
| `timeoutMs`  | `number` | `15000`                                   | Navigation and selector timeout in milliseconds                             |

## Tool

The plugin registers the `google_keep_list` agent tool:

| Parameter | Type                | Description                                             |
| --------- | ------------------- | ------------------------------------------------------- |
| `listUrl` | `string` (optional) | Google Keep note URL — overrides the configured default |
| `limit`   | `number` (optional) | Maximum number of items to return                       |

Returns a JSON object `{ items: string[], count: number, url: string }`.

## Notes

- Only **unchecked** list items are returned. Checked items and non-list notes return an empty array.
- The browser profile is stored locally — credentials never leave your machine.
- If the tool fails with an auth error, run `/keep login` to refresh the session.
