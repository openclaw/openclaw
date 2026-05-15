# Guardrail Bridge Plugin

Guardrail Bridge is a bundled OpenClaw plugin that runs before Agent dispatch. It blocks policy-violating input with either local keyword matching or a remote HTTP moderation provider.

## What It Does

- **Blacklist**: Matches input against a local keyword file with Aho-Corasick multi-pattern search.
- **HTTP**: Calls a remote moderation API through built-in providers: `dknownai`, `secra`, and `hidylan`.
- **Per-channel overrides**: Lets each channel choose a connector and override connector options independently.

The plugin is disabled unless it is enabled in the OpenClaw plugin configuration.

## Compatibility

- **Bundled package**: `@openclaw/guardrail-bridge-plugin`
- **Plugin ID**: `guardrail-bridge`
- **Supported Plugin API**: `>=2026.5.10-beta.1`

Compatibility metadata is declared in `package.json` and `openclaw.plugin.json` so OpenClaw can discover the plugin without executing runtime code.

## Configuration

### Blacklist Connector

```json5
{
  plugins: {
    entries: {
      "guardrail-bridge": {
        enabled: true,
        config: {
          connector: "blacklist",
          blacklist: {
            blacklistFile: true,
            caseSensitive: false,
            hot: true,
          },
          blockMessage: "This request has been blocked by the guardrail policy.",
          fallbackOnError: "pass",
        },
      },
    },
  },
}
```

When `blacklistFile` is `true`, the plugin uses the default state file at `~/.openclaw/guardrail-bridge/keywords.txt`. Set it to a string path to use a custom keyword file.

### HTTP Connector

```json5
{
  plugins: {
    entries: {
      "guardrail-bridge": {
        enabled: true,
        config: {
          connector: "http",
          http: {
            provider: "dknownai",
            apiKey: {
              source: "env",
              provider: "default",
              id: "DKNOWNAI_API_KEY",
            },
          },
          fallbackOnError: "block",
        },
      },
    },
  },
}
```

Use OpenClaw SecretRef values for provider credentials whenever possible. Plain string API keys are supported for local testing and migration, but are not recommended for shared config. SecretRef values are resolved at request time inside the plugin `check()` path, not during plugin registration or provider `init()`.

```json5
{
  http: {
    provider: "secra",
    apiKey: {
      source: "env",
      provider: "default",
      id: "SECRA_API_KEY",
    },
  },
}
```

A SecretRef can target OpenClaw's configured secret providers. Environment-style references such as `${DKNOWNAI_API_KEY}` are accepted through the shared SecretRef parser as env references when they match the OpenClaw secret-input contract; they are not expanded by guardrail-bridge itself.

### Per-Channel Override

```json5
{
  plugins: {
    entries: {
      "guardrail-bridge": {
        enabled: true,
        config: {
          channels: {
            "discord:@announcements": {
              connector: "http",
              http: {
                provider: "dknownai",
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "DKNOWNAI_API_KEY",
                },
              },
              blockMessage: "Only compliant content is allowed.",
            },
          },
        },
      },
    },
  },
}
```

Channel configs partially merge object fields such as `http` and `blacklist`, and replace scalar fields such as `blockMessage`, `fallbackOnError`, and `timeoutMs`. If a channel retargets `http.provider` or `http.apiUrl` without setting its own `http.apiKey`, the global key is dropped so credentials are not sent to an unintended service.

## Common Fields

| Field             | Default                                                         | Description                                                                                     |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `connector`       | `""`                                                            | Connector type: `"blacklist"` or `"http"`. Empty auto-detects from configured connector fields. |
| `timeoutMs`       | 5000                                                            | Single check timeout in milliseconds, from 500 to 30000.                                        |
| `fallbackOnError` | `"pass"`                                                        | Fallback action when a connector fails: `"pass"` or `"block"`.                                  |
| `blockMessage`    | `This request has been blocked by the guardrail-bridge policy.` | Message returned to the user when a request is blocked.                                         |

## Blacklist Fields

| Field           | Default | Description                                                                                                             |
| --------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `blacklistFile` | `false` | Keyword source. `true` uses the default state file, a string uses that path, and `false` disables file-backed matching. |
| `caseSensitive` | `false` | Enables case-sensitive matching.                                                                                        |
| `hot`           | `false` | Reloads the keyword file when it changes.                                                                               |
| `hotDebounceMs` | 300     | Hot-reload debounce interval in milliseconds.                                                                           |

## HTTP Fields

| Field      | Required              | Description                                                      |
| ---------- | --------------------- | ---------------------------------------------------------------- |
| `provider` | Yes                   | Provider name: `dknownai`, `secra`, or `hidylan`. |
| `apiKey`   | Yes, except `hidylan` | Provider API key. Can use environment variable substitution.     |
| `apiUrl`   | Provider-dependent    | Endpoint URL override.                                           |
| `model`    | No                    | Model name. Built-in providers currently ignore this field.      |
| `params`   | No                    | Provider-specific parameters, such as `project_id` or `region`.  |

## Public Extension Surface

`api.ts` exports the custom HTTP provider registration surface:

```ts
import { registerHttpProvider } from "./api.js";
```

Use `registerHttpProvider(name, adapter)` from plugin-local code to register additional HTTP providers.

## License

MIT
