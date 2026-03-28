# TouchBridge Setup Reference

## Install from Source (Recommended)

Building from source lets you audit the code before running it.

```bash
git clone https://github.com/HMAKT99/UnTouchID.git
cd UnTouchID

# Review the install script before running:
cat scripts/install.sh

# Build
cd daemon && swift build -c release && cd ..
make -C pam

# Install (will ask for admin password, shows diff before patching PAM)
sudo bash scripts/install.sh
```

## Install from .pkg (Alternative)

If you prefer the pre-built installer, **verify the checksum first**:

```bash
# Download
curl -L -o /tmp/TouchBridge.pkg https://github.com/HMAKT99/UnTouchID/releases/download/v0.1.0-alpha/TouchBridge-0.1.0.pkg

# Verify integrity — must match this hash:
shasum -a 256 /tmp/TouchBridge.pkg
# Expected: 370b8f0ab32c23216f16de19c8487633301be2810b9fa8793e3ac093f7699f9e

# Verify code signing (if notarised):
spctl -a -t install /tmp/TouchBridge.pkg

# Install
open /tmp/TouchBridge.pkg
```

## Production Use — Phone Auth

```bash
# Option A: Any phone via browser (no app install)
touchbridged serve --web

# Option B: Paired iPhone/Android via BLE
touchbridged serve
```

```bash
# Test sudo
sudo echo test
# → Phone prompts biometric → approve → sudo succeeds
```

## Testing Only — Simulator

⚠️ **WARNING: Simulator mode auto-approves ALL sudo requests without any biometric check. Never use in production. Only use for testing in a controlled environment.**

```bash
# Only for testing — requires explicit user consent
touchbridged serve --simulator

# In another terminal
sudo echo 'TouchBridge works!'
# → Auto-approved, no phone needed
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
