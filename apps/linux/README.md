# OpenClaw for Linux

The Linux companion is a Tauri v2 desktop shell for a local OpenClaw Gateway. It installs the CLI when needed, delegates Gateway service management to `openclaw gateway`, opens the Gateway-served Control UI with its resolved auth URL, and stays available in the system tray.

## Linux prerequisites

Debian and Ubuntu development packages:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Install a current stable Rust toolchain with `rustup`.

## Develop and build

The frontend is static HTML, CSS, and JavaScript. It has no package install or build step.

```bash
cd apps/linux/src-tauri
cargo run
cargo build
```

The app uses `OPENCLAW_DESKTOP_CLI` when set. Otherwise it checks `~/.openclaw/bin/openclaw`, then `openclaw` on `PATH`.

## Installer resource

`tauri.conf.json` bundles the repository's canonical `scripts/install-cli.sh` directly as `install-cli.sh`. The app never keeps a forked copy. Stable, beta, and dev installs select `latest`, `beta`, and a managed Git `main` checkout respectively, always under `~/.openclaw`.

## Icons

Committed PNGs come from `ui/public/favicon.svg`:

```bash
magick ui/public/favicon.svg -background none -resize 32x32 -alpha on -define png:color-type=6 PNG32:apps/linux/src-tauri/icons/32x32.png
magick ui/public/favicon.svg -background none -resize 128x128 -alpha on -define png:color-type=6 PNG32:apps/linux/src-tauri/icons/128x128.png
magick ui/public/favicon.svg -background none -resize 256x256 -alpha on -define png:color-type=6 PNG32:apps/linux/src-tauri/icons/128x128@2x.png
magick ui/public/favicon.svg -background none -resize 512x512 -alpha on -define png:color-type=6 PNG32:apps/linux/src-tauri/icons/icon.png
```

Packaged AppImage and Debian releases are not part of the initial app. Build on Linux when validating WebKitGTK, systemd user services, and tray integration.
