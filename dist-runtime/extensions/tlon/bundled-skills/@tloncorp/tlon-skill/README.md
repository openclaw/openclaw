# Tlon Skill

A CLI tool for interacting with Tlon/Urbit APIs.

## Installation

**npm:**
```bash
npm install @tloncorp/tlon-skill
```

**Direct download (no Node required):**
```bash
# macOS ARM64
curl -L https://registry.npmjs.org/@tloncorp/tlon-skill-darwin-arm64/-/tlon-skill-darwin-arm64-0.1.0.tgz | tar -xz
mv package/tlon /usr/local/bin/

# macOS x64
curl -L https://registry.npmjs.org/@tloncorp/tlon-skill-darwin-x64/-/tlon-skill-darwin-x64-0.1.0.tgz | tar -xz

# Linux x64
curl -L https://registry.npmjs.org/@tloncorp/tlon-skill-linux-x64/-/tlon-skill-linux-x64-0.1.0.tgz | tar -xz
```

## Configuration

**Option 1: CLI flags (highest priority)**
```bash
# Cookie-based auth (fastest - ship parsed from cookie)
tlon --url https://your-ship.tlon.network --cookie "urbauth-~your-ship=0v..." contacts self

# Code-based auth (requires all three)
tlon --url https://your-ship.tlon.network --ship ~your-ship --code sampel-ticlyt-migfun-falmel contacts self

# Or use a config file
tlon --config ~/ships/my-ship.json contacts self
```

Config file format:
```json
// Cookie-based (ship derived from cookie)
{"url": "https://your-ship.tlon.network", "cookie": "urbauth-~your-ship=0v..."}

// Code-based
{"url": "https://your-ship.tlon.network", "ship": "~your-ship", "code": "sampel-ticlyt-migfun-falmel"}
```

**Option 2: Environment variables**
```bash
# Cookie-based (ship derived from cookie)
export URBIT_URL="https://your-ship.tlon.network"
export URBIT_COOKIE="urbauth-~your-ship=0v..."

# Code-based
export URBIT_URL="https://your-ship.tlon.network"
export URBIT_SHIP="~your-ship"
export URBIT_CODE="sampel-ticlyt-migfun-falmel"
```

**Option 3: OpenClaw config**

If you have OpenClaw configured with a Tlon channel, credentials are loaded automatically.

## Cookie Caching

The skill automatically caches auth cookies to `~/.tlon/cache/<ship>.json` after successful authentication.

```bash
# First time - auth and cache
$ tlon --url https://zod.tlon.network --ship ~zod --code abcd-efgh contacts self
Note: Credentials cached for ~zod. Next time just run: tlon <command>

# After that - no flags needed!
$ tlon contacts self

# Multiple cached ships? Specify which one:
$ tlon --ship ~zod contacts self
```

Clear cache: `rm ~/.tlon/cache/*.json`

## Cookie vs Code Authentication

- **Cookie-based auth**: Uses a pre-authenticated session cookie. Faster since it skips login.
- **Code-based auth**: Performs a login request to get a session cookie.

The ship name is embedded in the cookie (`urbauth-~ship=...`), so you don't need to specify it separately with cookie auth.

## Multi-Ship Usage

If you have credentials for multiple ships, you can operate on behalf of any of them:

```bash
# Act as a different ship
tlon --config ~/ships/bot.json channels groups

# Or pass credentials directly
tlon --url https://bot.tlon.network --cookie "urbauth-~bot=0v..." contacts self
```

## Usage

```bash
# List your groups
tlon channels groups

# Get recent mentions
tlon activity mentions --limit 10

# Fetch DM history
tlon messages dm ~sampel-palnet --limit 20

# Update your profile
tlon contacts update-profile --nickname "My Name"

# Create a group
tlon groups create "My Group" --description "A cool group"
```

## Features

- **Activity**: Mentions, replies, unreads (with nicknames)
- **Channels**: List DMs, group DMs, subscribed groups (nicknames shown), reader/writer permissions
- **Contacts**: List, get, update profiles
- **Groups**: Create, join, invite, roles, privacy (member nicknames shown)
- **Hooks**: Manage channel hooks (add, edit, delete, order, config, cron)
- **Messages**: History, search (author nicknames shown)
- **DMs**: Send, react, accept/decline
- **Posts**: React, delete
- **Notebook**: Post to diary channels
- **Settings**: Hot-reload plugin config via settings-store

## Documentation

See [SKILL.md](SKILL.md) for full command reference.

## For Hosted Deployments

If you're running this in a hosted/K8s environment with additional features (workspace files, settings-store, click commands), see [@tloncorp/tlonbot](https://github.com/tloncorp/tlonbot).

## License

MIT
