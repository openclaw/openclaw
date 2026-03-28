# TouchBridge Setup Reference

## Quick Install

Download and run the .pkg installer:
```bash
# Download from GitHub Release
curl -L -o /tmp/TouchBridge.pkg https://github.com/HMAKT99/UnTouchID/releases/download/v0.1.0-alpha/TouchBridge-0.1.0.pkg
open /tmp/TouchBridge.pkg
```

Or build from source:
```bash
git clone https://github.com/HMAKT99/UnTouchID.git
cd UnTouchID
cd daemon && swift build -c release && cd ..
make -C pam
sudo bash scripts/install.sh
```

## Test (no phone needed)

```bash
# Terminal 1
touchbridged serve --simulator

# Terminal 2
sudo echo 'TouchBridge works!'
# → Auto-approved, no password prompt
```

## Use with any phone (no app install)

```bash
# Terminal 1
touchbridged serve --web

# Terminal 2
sudo echo test
# → Shows a URL in Terminal 1
# → Open URL on any phone → tap Approve
```

## Pair iPhone or Android

```bash
touchbridge-test pair
# Shows pairing JSON → enter in companion app
```

## View auth history

```bash
touchbridge-test logs
touchbridge-test logs --surface pam_sudo --count 20
```

## Uninstall

```bash
sudo bash scripts/uninstall.sh
# Restores original PAM config, removes daemon
```
