# spotify_player — Headless / Container Setup

Setting up `spotify_player` on headless Linux or inside containers (Docker, Kubernetes) requires extra steps because the binary depends on an audio backend and its `authenticate` command has a credential-caching gap.

## Known Issues

### 1. `authenticate` does not persist credentials

`spotify_player authenticate` completes the OAuth flow and writes `user_client_token.json` to the cache folder, but **does not save librespot session credentials** to `credentials.json`. The session credentials are only saved when the full TUI player connects to Spotify.

**Fix:** After authenticating, manually create `~/.cache/spotify-player/credentials.json`:

```bash
python3 << 'PYEOF'
import json, base64, os

with open(os.path.expanduser("~/.cache/spotify-player/user_client_token.json")) as f:
    token = json.load(f)

creds = {
    "username": None,
    "auth_type": 3,  # AUTHENTICATION_SPOTIFY_TOKEN (0x3 in Spotify protobuf)
    "auth_data": base64.b64encode(token["access_token"].encode()).decode()
}

path = os.path.expanduser("~/.cache/spotify-player/credentials.json")
with open(path, "w") as f:
    json.dump(creds, f)
os.chmod(path, 0o600)
print(f"Wrote {path}")
PYEOF
```

> **Note:** `auth_type` must be `3`, not `14`. The Spotify protobuf defines `AUTHENTICATION_SPOTIFY_TOKEN = 0x3`. Using the wrong value causes silent deserialization failure — the cache reads the file but returns `None`.

### 2. No audio device (ALSA errors)

The TUI player crashes on startup if no audio output is available.

**Fix:** Install PulseAudio and create a null sink:

```bash
apt-get install -y pulseaudio
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=virtual_speaker \
  sink_properties=device.description="Virtual_Speaker"
```

### 3. CLI commands return "Connection refused"

The `get`, `playback`, `search`, and other CLI subcommands communicate with a running TUI instance over a local socket. If the TUI is not running, they fail.

**Fix:** Start the TUI in the background with a pseudo-terminal:

```bash
script -q -c "spotify_player" /dev/null &
```

### 4. D-Bus / keyring not available (containers)

Containers typically lack a D-Bus session bus. While `spotify_player` v0.22+ uses file-based caching (not keyring) for credentials, the OAuth browser-open step uses D-Bus to query `org.gnome.SessionManager` and will log errors. These errors are harmless — they only affect the auto-open-browser feature, which you bypass by navigating to the OAuth URL manually anyway.

If you see `Error org.freedesktop.DBus.Error.NameHasNoOwner`, you can safely ignore it or set up a session bus:

```bash
apt-get install -y dbus dbus-x11
dbus-daemon --session --address=unix:path=/tmp/dbus-session-bus --nofork &
export DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/dbus-session-bus"
```

## Complete Headless Setup (step by step)

```bash
# 1. Install spotify_player (GitHub releases)
curl -sL https://github.com/aome510/spotify-player/releases/latest/download/spotify_player_linux-x64.tar.gz \
  | tar xz -C /usr/local/bin/

# 2. Install PulseAudio + create null sink
apt-get install -y pulseaudio
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=virtual_speaker

# 3. Authenticate (opens OAuth URL you visit in any browser)
spotify_player authenticate
# Visit the printed URL, authorize, and wait for callback

# 4. Create credentials.json from the token (see fix #1 above)

# 5. Start the TUI in background
script -q -c "spotify_player" /dev/null &
sleep 5

# 6. Verify
spotify_player get key devices
```

## Token Refresh

The access token in `credentials.json` expires after ~1 hour. When the TUI is running, it handles refresh automatically and updates `credentials.json`. If the TUI has been stopped for a long time and the token expired, re-run `spotify_player authenticate` and recreate `credentials.json` using the script above.
