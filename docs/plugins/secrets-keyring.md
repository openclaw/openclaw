---
summary: "OS keyring secret provider plugin: resolve SecretRef sources of type keyring via macOS Keychain or Linux libsecret"
read_when:
  - You want to resolve OpenClaw SecretRefs from the OS-native credential store
  - You are configuring the bundled secrets-keyring plugin on macOS or Linux
  - You need keychain unlock or libsecret install troubleshooting
title: "OS keyring secret provider plugin"
sidebarTitle: "Secrets keyring"
---

`secrets-keyring` is a bundled plugin that owns the `keyring` SecretRef
source. It resolves SecretRef ids against the OS-native credential store:
macOS Keychain via the `security` CLI, Linux libsecret via `secret-tool`.

The plugin is `enabledByDefault: false` and shells out to platform tools at
resolve time. There are no npm runtime dependencies and no startup cost when
unconfigured.

## Platform support

| Platform | Backend                                 | Required tooling                                                          |
| -------- | --------------------------------------- | ------------------------------------------------------------------------- |
| macOS    | Keychain Services (`/usr/bin/security`) | Always present on macOS.                                                  |
| Linux    | libsecret (`secret-tool`)               | Install `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora/Arch).   |
| Windows  | Not supported                           | The plugin throws on Windows. Use `file` or a third-party plugin instead. |

## Quick start

1. Enable the plugin:

   ```json5
   {
     plugins: {
       entries: {
         "secrets-keyring": { enabled: true },
       },
     },
   }
   ```

2. Configure a provider alias under `secrets.providers`:

   ```json5
   {
     secrets: {
       providers: {
         local: { source: "keyring", service: "openclaw" },
       },
     },
   }
   ```

<Note>
The interactive `openclaw secrets configure` flow does not currently list
plugin-owned sources in its source picker. Edit `openclaw.json` directly to
add a `keyring` provider entry; resolution at runtime works the same either way.
</Note>

3. Store a credential in the OS keyring (see platform sections below), then
   reference it anywhere SecretRef is accepted:

   ```json5
   {
     models: {
       providers: {
         openai: {
           apiKey: { source: "keyring", provider: "local", id: "openai-api-key" },
         },
       },
     },
   }
   ```

## Configuration

| Field          | Type        | Required        | Description                                                                                                                      |
| -------------- | ----------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `source`       | `"keyring"` | yes             | Discriminator. Must be the literal string `"keyring"`.                                                                           |
| `service`      | `string`    | no              | macOS Keychain service attribute / libsecret `service` attribute. Default `"openclaw"`. Must match `^[A-Za-z0-9._-]{1,128}$`.    |
| `keychainPath` | `string`    | no (macOS only) | Absolute path to a `.keychain-db` or `.keychain` file. Defaults to `~/Library/Keychains/openclaw.keychain-db`. Ignored on Linux. |

SecretRef ids in this source must match `^[A-Za-z0-9._/-]{1,256}$`. Argv-injection
guards reject ids and service/path values that start with `-`.

## macOS setup

The default behavior reads from a custom keychain at
`~/Library/Keychains/openclaw.keychain-db`. This keeps OpenClaw secrets
separate from your login keychain and avoids GUI password prompts in headless
or remote-shell flows.

### Create a dedicated OpenClaw keychain (recommended)

```sh
# Create the keychain with a password.
security create-keychain -p "your-keychain-password" ~/Library/Keychains/openclaw.keychain-db

# Unlock and disable lock-on-sleep.
security unlock-keychain -p "your-keychain-password" ~/Library/Keychains/openclaw.keychain-db
security set-keychain-settings -t 3600 -l ~/Library/Keychains/openclaw.keychain-db

# Add it to the search list so the GUI can find it too.
security list-keychains -d user -s \
  ~/Library/Keychains/login.keychain-db \
  ~/Library/Keychains/openclaw.keychain-db

# Store a secret. -s holds the configured `service`, -a holds the SecretRef `id`.
security add-generic-password \
  -s openclaw \
  -a openai-api-key \
  -w "sk-..." \
  ~/Library/Keychains/openclaw.keychain-db
```

This matches macOS Keychain native semantics: `-s` is the service-name
attribute and `-a` is the account attribute. The OpenClaw `service` config
field maps to the Keychain service slot; the SecretRef `id` maps to the
account slot. Anything you store with this `security add-generic-password`
shape can be looked up by the plugin without further mapping.

### Use the login keychain

If you prefer the standard login keychain, set `keychainPath` explicitly:

```json5
{
  secrets: {
    providers: {
      local: {
        source: "keyring",
        keychainPath: "/Users/<you>/Library/Keychains/login.keychain-db",
      },
    },
  },
}
```

The login keychain may prompt for an unlock password the first time
OpenClaw runs unless your session is already unlocked.

## Linux setup

Install `secret-tool` and a libsecret backend:

```sh
# Debian / Ubuntu
sudo apt install libsecret-tools gnome-keyring

# Fedora
sudo dnf install libsecret libsecret-devel gnome-keyring

# Arch
sudo pacman -S libsecret gnome-keyring
```

Store a secret:

```sh
secret-tool store --label="OpenClaw OpenAI key" service openclaw key openai-api-key
# (paste the secret value at the prompt)
```

KDE users can use `kwalletd6` as the libsecret backend; it speaks the
freedesktop Secret Service API and works with `secret-tool` transparently.

## Examples

<AccordionGroup>
  <Accordion title="Multiple services in one keychain">
    Use a different `service` per logical scope:

    ```json5
    {
      secrets: {
        providers: {
          openclawCreds: { source: "keyring", service: "openclaw" },
          deployCreds: { source: "keyring", service: "deploy" },
        },
      },
    }
    ```

  </Accordion>
  <Accordion title="Per-tool macOS keychains">
    Store CI / agent credentials in a separate keychain so they are
    independently unlockable:

    ```json5
    {
      secrets: {
        providers: {
          ci: {
            source: "keyring",
            keychainPath: "/Users/<you>/Library/Keychains/openclaw-ci.keychain-db",
          },
        },
      },
    }
    ```

  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="macOS: User interaction is not allowed">
    The keychain is locked and the process has no GUI to prompt for the
    password. Either unlock the keychain in the same session before running
    OpenClaw:

    ```sh
    security unlock-keychain -p "your-keychain-password" ~/Library/Keychains/openclaw.keychain-db
    ```

    Or use a dedicated keychain whose password you store separately and unlock
    in your login profile.

  </Accordion>
  <Accordion title="Linux: secret-tool not found">
    The plugin emits a distinct error when the CLI is missing on PATH:

    > Keyring provider requires the libsecret `secret-tool` CLI on Linux but
    > it was not found on PATH. Install libsecret-tools (Debian/Ubuntu) or
    > libsecret (Fedora/Arch) and try again.

    Install the package above and rerun `openclaw secrets reload`.

  </Accordion>
  <Accordion title="Linux: secret not found in libsecret">
    Verify the secret exists with the exact attributes the plugin uses:

    ```sh
    secret-tool lookup service openclaw key openai-api-key
    ```

    If the lookup is empty, store it again with `secret-tool store ...`.
    Confirm a libsecret backend is running (`gnome-keyring-daemon` or
    `kwalletd6`).

  </Accordion>
  <Accordion title="ref id or service rejected">
    The plugin rejects ref ids and service/path values that start with `-`
    or contain characters outside the documented patterns, before any spawn.
    This is an argv-injection guard. Rename the secret with allowed
    characters (letters, digits, `_`, `-`, `.`, `/` for ref ids).
  </Accordion>
  <Accordion title="Plugin not loaded">
    Confirm the entry is enabled: `openclaw plugins status` should list
    `secrets-keyring` as enabled. If not, set
    `plugins.entries.secrets-keyring.enabled = true` in your config.
  </Accordion>
</AccordionGroup>

## Related

- [Secrets management](/gateway/secrets) — SecretRef contract, runtime
  snapshot behavior, and built-in providers.
- [GCP secret provider plugin](/plugins/secrets-gcp) — sibling plugin for
  Google Cloud Secret Manager.
- [Plugin SDK overview](/plugins/sdk-overview) — for plugin authors building
  additional secret-provider plugins.
