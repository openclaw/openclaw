# @openclaw/telegram-files

Telegram Mini App for managing agent workspace files on mobile.

## Overview

This plugin adds a `/files` command that opens a Telegram Mini App (WebApp) directly inside Telegram, allowing you to:

- Browse directories on the agent's filesystem
- View and edit text files with a mobile-friendly editor
- Create new files and folders
- Delete files and directories
- Search for files by name
- Toggle hidden file visibility

All operations are secured with token-based authentication, path whitelisting, and automatic token expiration.

## Installation

```bash
openclaw plugins install @openclaw/telegram-files
```

## Quick Setup

1. Expose your gateway over HTTPS (e.g. via Tailscale Funnel, Cloudflare Tunnel, or ngrok):

   ```bash
   # Example with Tailscale
   tailscale funnel 3117
   ```

2. Configure the plugin with your external URL:

   ```bash
   openclaw config set plugins.entries.telegram-files.config.externalUrl "https://your-host.ts.net"
   ```

3. (Optional) Restrict filesystem access to specific directories:

   ```bash
   openclaw config set plugins.entries.telegram-files.config.allowedPaths '["/home/user", "/opt/projects"]'
   ```

4. Restart the gateway, then send `/files` in Telegram.

## Configuration

| Key            | Type     | Default          | Description                                                               |
| -------------- | -------- | ---------------- | ------------------------------------------------------------------------- |
| `externalUrl`  | string   | required         | HTTPS URL where the gateway is reachable (used for Mini App button URL)   |
| `allowedPaths` | string[] | `[os.homedir()]` | Allowed filesystem paths. If empty, defaults to the user's home directory |

### Example Config

```json
{
  "plugins": {
    "entries": {
      "telegram-files": {
        "config": {
          "externalUrl": "https://my-server.ts.net",
          "allowedPaths": ["/home/user", "/opt/openclaw"]
        }
      }
    }
  }
}
```

## Usage

1. Send `/files` to your bot in Telegram
2. Tap the **Open File Manager** button
3. Browse, edit, create, or delete files from your phone

### Features

- **Directory browsing** — navigate the filesystem with breadcrumb path display
- **File editing** — full-screen textarea with save via Telegram MainButton
- **File metadata** — file size (KB/MB) and relative modification time (e.g. "2h ago")
- **Hidden files toggle** — show/hide dotfiles, preference saved in localStorage
- **New file** — tap "+ New File", enter a name, and start editing
- **New folder** — tap "+ New Folder" to create directories
- **Delete** — delete files or folders with confirmation dialog
- **Search** — search files by name within current directory (recursive, max 5 levels deep)
- **Binary protection** — binary files show a friendly "cannot edit" notice instead of garbled text

## Security

### Authentication Flow

1. User sends `/files` in Telegram
2. Bot generates a one-time pairing code (5-minute TTL)
3. Mini App exchanges the code for a session token
4. Session token expires after **24 hours** — user must re-run `/files` to get a new one

### Path Whitelisting

All API endpoints enforce path restrictions:

- If `allowedPaths` is configured, only those directories (and their children) are accessible
- If `allowedPaths` is empty (default), only the home directory is accessible
- Attempting to access paths outside the whitelist returns `403 Forbidden`

### Operation Logging

All write operations are logged to the gateway console:

```
[telegram-files] WRITE /home/user/file.txt by token a1b2c3d4...
[telegram-files] DELETE /home/user/old.txt by token a1b2c3d4...
[telegram-files] MKDIR /home/user/new-dir by token a1b2c3d4...
```

## API Reference

All endpoints are under `/plugins/telegram-files/api/` and require `Authorization: Bearer <token>` (except exchange).

| Method | Endpoint        | Description                      |
| ------ | --------------- | -------------------------------- |
| POST   | `/api/exchange` | Exchange pairing code for token  |
| GET    | `/api/ls`       | List directory (`?path=`)        |
| GET    | `/api/read`     | Read file content (`?path=`)     |
| POST   | `/api/write`    | Write file (`{ path, content }`) |
| POST   | `/api/mkdir`    | Create directory (`{ path }`)    |
| DELETE | `/api/delete`   | Delete file/dir (`?path=`)       |
| GET    | `/api/search`   | Search files (`?path=&q=`)       |

## Layout

```
telegram-files/
├── openclaw.plugin.json     # Plugin metadata and config schema
├── package.json
├── index.ts                 # Plugin entry point
├── src/
│   ├── register.ts          # Command + HTTP API handler
│   ├── pairing.ts           # One-time pairing code store
│   ├── runtime.ts           # OpenClaw runtime bridge
│   └── static-server.ts     # Static file server for webapp
└── webapp/
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── main.ts           # Webapp entry
        ├── app.ts            # Routing (dir list ↔ editor)
        ├── services/
        │   ├── auth.ts       # Token exchange
        │   ├── files-api.ts  # REST client
        │   └── telegram.ts   # Telegram WebApp SDK
        ├── views/
        │   ├── file-list.ts  # Directory browser
        │   └── file-editor.ts # File editor
        └── styles/
            └── theme.css     # Telegram theme integration
```

## Troubleshooting

### "Please set externalUrl" error

Set the external URL where your gateway is reachable over HTTPS:

```bash
openclaw config set plugins.entries.telegram-files.config.externalUrl "https://your-host"
```

### Mini App shows "unauthorized"

The session token has expired (24h TTL). Send `/files` again to get a fresh pairing code.

### Cannot access certain directories

Check your `allowedPaths` configuration. By default, only the home directory is accessible. Add paths as needed:

```bash
openclaw config set plugins.entries.telegram-files.config.allowedPaths '["/path/to/allow"]'
```

### Binary file error

Binary files (images, executables, etc.) cannot be edited as text. The editor will show a "Binary File" notice.

## License

MIT
