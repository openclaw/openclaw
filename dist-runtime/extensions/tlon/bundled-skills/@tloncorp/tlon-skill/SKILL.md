---
name: tlon
description: Interact with Tlon/Urbit API. Use for contacts (get/update profiles), listing channels/groups, fetching message history, posting to channels, sending DMs, group management, and exposing content to the clearweb.
---

# Tlon Skill

Use the `tlon` command for all Tlon operations.

## Installation

**npm (Node.js):**
```bash
npm install @tloncorp/tlon-skill
tlon channels groups
```

**Direct binary (no Node required):**
```bash
curl -L https://registry.npmjs.org/@tloncorp/tlon-skill-darwin-arm64/-/tlon-skill-darwin-arm64-0.1.0.tgz | tar -xz
./package/tlon channels groups
```

Replace `darwin-arm64` with `darwin-x64` or `linux-x64` as needed.


## Configuration

**CLI Flags (highest priority):**
```bash
# Cookie-based auth (fastest - ship parsed from cookie name)
tlon --url https://your-ship.tlon.network --cookie "urbauth-~your-ship=0v..." <command>

# Code-based auth (requires url + ship + code)
tlon --url https://your-ship.tlon.network --ship ~your-ship --code sampel-ticlyt-migfun-falmel <command>

# Or load from a JSON config file
tlon --config ~/ships/my-ship.json <command>
```

Config file format:
```json
// Cookie-based (ship derived from cookie)
{"url": "...", "cookie": "urbauth-~ship=..."}

// Code-based
{"url": "...", "ship": "~...", "code": "..."}
```

**Environment Variables:**
```bash
# Cookie-based (ship derived from cookie)
export URBIT_URL="https://your-ship.tlon.network"
export URBIT_COOKIE="urbauth-~your-ship=0v..."

# Code-based
export URBIT_URL="https://your-ship.tlon.network"
export URBIT_SHIP="~your-ship"
export URBIT_CODE="sampel-ticlyt-migfun-falmel"
```

**OpenClaw:** If configured with a Tlon channel, credentials load automatically.

**Resolution order:** CLI flags → `TLON_CONFIG_FILE` → `URL + COOKIE` → `URL + SHIP + CODE` → `--ship` with cache → OpenClaw config → cached ships (auto-select if only one)

**Cookie vs Code:**
- **Cookie-based:** Uses pre-authenticated session cookie. Ship is parsed from the cookie name (`urbauth-~ship=...`). Fastest option.
- **Code-based:** Performs login to get session cookie. Requires URL + ship + code.

You can provide both cookie and code — cookie is used first, code serves as fallback if cookie expires.

## Cookie Caching

The skill automatically caches auth cookies to `~/.tlon/cache/<ship>.json` after successful authentication. This makes subsequent invocations much faster by skipping the login request.

**How it works:**
```bash
# First time - authenticates and caches
$ tlon --url https://zod.tlon.network --ship ~zod --code abcd-efgh contacts self
~zod
Note: Credentials cached for ~zod. Next time just run: tlon <command>

# After that - no flags needed (if only one cached ship)
$ tlon contacts self
~zod

# With multiple cached ships - specify which one
$ tlon --ship ~zod contacts self
$ tlon --ship ~bus contacts self
```

**Cache behavior:**
- Cached cookies are URL-specific (won't use a cookie for the wrong host)
- If only one ship is cached, it's auto-selected (no flags needed)
- If multiple ships are cached, you'll be prompted to specify with `--ship`
- The skill reminds you when you pass credentials that aren't needed

**Clear cache:** `rm ~/.tlon/cache/*.json`



## Multi-Ship Usage

If you have credentials for multiple ships, you can use this skill to operate on behalf of any of them. This is useful for:

- **Managing multiple identities** — switch between ships without changing environment variables
- **Bot operations** — act as a bot ship while authenticated as yourself
- **Moon management** — operate moons from their parent planet

Simply pass the target ship's credentials via CLI flags:

```bash
# Post to a channel as ~other-ship
tlon --url https://other-ship.tlon.network --ship ~other-ship --code their-access-code \
  posts send chat/~host/channel "Hello from other-ship"

# Or keep credentials in config files
tlon --config ~/ships/bot.json channels groups
tlon --config ~/ships/moon.json contacts self
```

## Commands

### Activity

Check recent notifications and unread counts. Ships are shown with nicknames when available.

```bash
tlon activity mentions --limit 10   # Recent mentions (max 25)
tlon activity replies --limit 10    # Recent replies (max 25)
tlon activity all --limit 10        # All recent activity (max 25)
tlon activity unreads               # Unread counts per channel
```

### Channels

List and manage channels. DMs and group DMs show nicknames when available.

```bash
tlon channels dms                                          # List DM contacts (with nicknames)
tlon channels group-dms                                    # List group DMs (clubs, with nicknames)
tlon channels groups                                       # List subscribed groups
tlon channels all                                          # List everything
tlon channels info chat/~host/slug                         # Get channel details
tlon channels update chat/~host/slug --title "New Title"   # Update metadata
tlon channels delete chat/~host/slug                       # Delete a channel

# Writers (who can post)
tlon channels add-writers chat/~host/slug admin member     # Add write access
tlon channels del-writers chat/~host/slug member           # Remove write access

# Readers (who can view - requires group flag)
tlon channels add-readers ~host/group chat/~host/slug admin    # Restrict viewing
tlon channels del-readers ~host/group chat/~host/slug admin    # Open viewing
```

Notes on permissions:
- Empty writers list = anyone in the group can post (default for chat)
- Empty readers list = anyone in the group can view (default)
- Diaries default to admin-only writers
- Roles must exist in the group (use `tlon groups add-role` first)

### Contacts

Manage contacts and profiles.

```bash
tlon contacts list                                   # List all contacts
tlon contacts self                                   # Get your own profile
tlon contacts get ~sampel                            # Get a contact's profile
tlon contacts sync ~ship1 ~ship2                     # Fetch/sync profiles
tlon contacts add ~sampel                            # Add a contact
tlon contacts remove ~sampel                         # Remove a contact
tlon contacts update-profile --nickname "My Name"    # Update your profile
```

Options: `--nickname`, `--bio`, `--status`, `--avatar`, `--cover`

### Groups

Full group management.

```bash
# Basics
tlon groups list                                         # List your groups
tlon groups info ~host/slug                              # Get group details
tlon groups create "Name" [--description "..."]          # Create a group
tlon groups join ~host/slug                              # Join a group
tlon groups leave ~host/slug                             # Leave a group
tlon groups delete ~host/slug                            # Delete (host only)
tlon groups update ~host/slug --title "..." [--description "..."]

# Members (shown with nicknames when available)
tlon groups invite ~host/slug ~ship1 ~ship2              # Invite members
tlon groups kick ~host/slug ~ship1                       # Kick members
tlon groups ban ~host/slug ~ship1                        # Ban members
tlon groups unban ~host/slug ~ship1                      # Unban members
tlon groups accept-join ~host/slug ~ship1                # Accept join request
tlon groups reject-join ~host/slug ~ship1                # Reject join request
tlon groups set-privacy ~host/slug public|private|secret # Set privacy

# Roles
tlon groups add-role ~host/slug role-id --title "..."    # Create a role
tlon groups delete-role ~host/slug role-id               # Delete a role
tlon groups update-role ~host/slug role-id --title "..." # Update a role
tlon groups assign-role ~host/slug role-id ~ship1        # Assign role
tlon groups remove-role ~host/slug role-id ~ship1        # Remove role

# Channels
tlon groups add-channel ~host/slug "Name" [--kind chat|diary|heap]
```

Group format: `~host-ship/group-slug`

### Hooks

Manage channel hooks — functions that run on triggers (posts, replies, reactions, crons).

```bash
# List and inspect
tlon hooks list                                          # List all hooks
tlon hooks get 0v1a.2b3c4                                # Get hook details and source

# Manage hooks
tlon hooks init my-hook --type on-post                   # Create starter template (on-post|cron|moderation)
tlon hooks add my-hook ./my-hook.hoon                    # Add a new hook from file
tlon hooks edit 0v1a.2b3c4 --name "New Name"             # Rename a hook
tlon hooks edit 0v1a.2b3c4 --src ./updated.hoon          # Update source
tlon hooks delete 0v1a.2b3c4                             # Delete a hook

# Configure for channels
tlon hooks order chat/~host/slug 0v1a 0v2b 0v3c          # Set execution order
tlon hooks config 0v1a chat/~host/slug key1=val1         # Configure hook instance

# Scheduled execution
tlon hooks cron 0v1a ~h1                                 # Run hourly (global)
tlon hooks cron 0v1a ~m30 --nest chat/~host/slug         # Run every 30m for channel
tlon hooks rest 0v1a                                     # Stop cron job
```

Notes:
- Hook IDs are @uv format (e.g., `0v1a.2b3c4...`)
- Schedules use @dr format: `~h1` (1 hour), `~m30` (30 minutes), `~d1` (1 day)
- Hooks run in order when triggered; use `order` to set priority
- Use `config` to pass channel-specific settings to a hook instance

**Writing Hooks:** See `references/hooks.md` for full documentation on writing hooks, including:
- Event types (`on-post`, `on-reply`, `cron`, `wake`)
- Bowl context (channel, group, config access)
- Effects (channel actions, group actions, scheduled wakes)
- Config handling with clam (`;;`)

**Examples:** See `references/hooks-examples/` for starter templates:
- `auto-react.hoon` — React to new posts with emoji
- `delete-old-posts.hoon` — Cron job to clean up old messages
- `word-filter.hoon` — Block posts containing banned words

### Messages

Read and search message history. Authors are shown with nicknames when available.

```bash
tlon messages dm ~sampel --limit 20                      # DM history (max 50)
tlon messages channel chat/~host/slug --limit 20         # Channel history (max 50)
tlon messages search "query" --channel chat/~host/slug   # Search messages
```

Options: `--limit N`, `--resolve-cites`

### DMs

Manage direct messages.

```bash
# Group DMs (clubs)
tlon dms send <club-id> "hello"                          # Send to group DM
tlon dms reply <club-id> ~author/170.141... "reply"      # Reply in group DM

# Management
tlon dms react ~sampel ~author/170.141... "👍"           # React to a DM
tlon dms unreact ~sampel ~author/170.141...              # Remove reaction
tlon dms delete ~sampel ~author/170.141...               # Delete a DM
tlon dms accept ~sampel                                  # Accept DM invite
tlon dms decline ~sampel                                 # Decline DM invite
```

### Expose

Publish Tlon content to the clearweb via the %expose agent.

```bash
tlon expose list                                         # List all exposed content
tlon expose show chat/~host/slug/170.141...              # Expose a post publicly
tlon expose hide chat/~host/slug/170.141...              # Hide an exposed post
tlon expose check diary/~host/blog/170.141...            # Check if a post is exposed
tlon expose url diary/~host/blog/170.141...              # Get the public URL
```

Cite path formats:
- Simplified: `chat/~host/channel/170.141...` (auto-expands)
- Full: `/1/chan/chat/~host/channel/msg/170.141...`

Channel kinds map to content types: chat→msg, diary→note, heap→curio

### Posts

Manage channel posts (reactions, edits, deletes).

```bash
tlon posts react chat/~host/slug 170.141... "👍"         # React to a post
tlon posts unreact chat/~host/slug 170.141...            # Remove reaction
tlon posts edit chat/~host/slug 170.141... "New text"    # Edit with plain text
tlon posts edit diary/~host/slug 170.141... --title "T" --image <url> --content rich.json  # Edit notebook
tlon posts delete chat/~host/slug 170.141...             # Delete a post
```

Edit options for notebooks: `--title`, `--image` (cover URL), `--content` (Story JSON file for rich formatting).

### Notebook

Post to diary/notebook channels.

```bash
tlon notebook diary/~host/slug "Title"                   # Post with no body
tlon notebook diary/~host/slug "Title" --content rich.json  # Post with Story JSON
tlon notebook diary/~host/slug "Title" --image <url>     # Post with cover image
```

The `--content` file should be Story JSON format (array of verses with headers, code blocks, formatting). See the [Story types in tlon-apps](https://github.com/tloncorp/tlon-apps/blob/develop/packages/shared/src/urbit/content.ts).

### Upload

Upload images to Tlon storage.

```bash
tlon upload https://example.com/image.png    # Upload image from URL
```

Returns the uploaded image URL for use in posts, profiles, etc.

### Settings (OpenClaw)

Manage OpenClaw's Tlon plugin config via Urbit settings-store. Changes apply immediately without gateway restart.

```bash
tlon settings get                                        # Show all settings
tlon settings set <key> <json-value>                     # Set a value
tlon settings delete <key>                               # Delete a setting

# DM allowlist
tlon settings allow-dm ~ship                             # Add to DM allowlist
tlon settings remove-dm ~ship                            # Remove from allowlist

# Channel controls
tlon settings allow-channel chat/~host/slug              # Add to watch list
tlon settings remove-channel chat/~host/slug             # Remove from watch list
tlon settings open-channel chat/~host/slug               # Set channel to open
tlon settings restrict-channel chat/~host/slug [~ship1]  # Set restricted

# Authorization
tlon settings authorize-ship ~ship                       # Add to default auth
tlon settings deauthorize-ship ~ship                     # Remove from auth
```

## Notes

- Ship names should include `~` prefix
- Post IDs are @ud format with dots (e.g. `170.141.184.507...`)
- DM post IDs include author prefix (`~ship/170.141...`)
- Channel nests: `<kind>/~<host>/<name>` (chat, diary, or heap)

## Limits

- Activity: max 25 items
- Messages: max 50 items
