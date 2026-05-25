# bw CLI examples (from bw --help)

## Login

- `bw login`
- `bw login <email>`
- `bw login --apikey` (uses BW_CLIENT_ID + BW_CLIENT_SECRET)
- `bw login --sso`

## Unlock

- `bw unlock`
- `bw unlock --raw` (outputs session key only, for scripts)

## Status

- `bw status` (shows login state, last sync, etc.)

## List

- `bw list items`
- `bw list items --search <query>`
- `bw list items --folderid <id>`
- `bw list folders`
- `bw list collections`
- `bw list organizations`

## Get

- `bw get item <id_or_name>`
- `bw get password <id_or_name>`
- `bw get username <id_or_name>`
- `bw get notes <id_or_name>`
- `bw get totp <id_or_name>`
- `bw get item <id> --raw` (outputs JSON)

## Search

- `bw list items --search "OpenClaw"`

## Sync

- `bw sync` (force sync with server)

## Logout

- `bw logout`

## Environment variables

- `BW_SESSION` - session key for unlock
- `BW_CLIENT_ID` - API key client ID
- `BW_CLIENT_SECRET` - API key client secret
- `BW_PASSWORD` - master password (avoid if possible)
- `BW_NOINTERACTION` - disable interactive prompts
