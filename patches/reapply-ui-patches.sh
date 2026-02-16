#!/bin/bash
# Reapply Control UI patches after OpenClaw updates
# Run this after: npm update -g openclaw
#
# Cross-platform: macOS (Homebrew) + Linux (nvm/global npm)
# Page title auto-detected from hostname (override with OPENCLAW_TITLE env var)

# --- Auto-detect platform and paths ---
if [ -d "/opt/homebrew/lib/node_modules/openclaw" ]; then
  OC_DIR="/opt/homebrew/lib/node_modules/openclaw"
elif [ -n "$NVM_DIR" ]; then
  OC_DIR="$(dirname "$(which openclaw 2>/dev/null)" 2>/dev/null)/../lib/node_modules/openclaw"
  [ ! -d "$OC_DIR/dist" ] && OC_DIR="$NVM_DIR/versions/node/$(node -v)/lib/node_modules/openclaw"
else
  OC_DIR="$(npm root -g)/openclaw"
fi

UI_DIR="$OC_DIR/dist/control-ui"
UI_HTML="$UI_DIR/index.html"
JS_FILE=$(ls "$UI_DIR/assets/index-"*.js 2>/dev/null | head -1)

# --- Detect OS for sed compatibility ---
if [[ "$OSTYPE" == "darwin"* ]]; then
  sedi() { sed -i '' "$@"; }
else
  sedi() { sed -i "$@"; }
fi

# --- Page title from env or hostname ---
PAGE_TITLE="${OPENCLAW_TITLE:-$(hostname)} - OpenClaw Control"

echo "🔧 Reapplying Control UI patches..."
echo "📁 OpenClaw dir: $OC_DIR"

if [ -z "$JS_FILE" ]; then
  echo "❌ Could not find Control UI JS file at $UI_DIR/assets/"
  exit 1
fi

echo "📁 JS file: $(basename "$JS_FILE")"

# --- Backup ---
cp "$JS_FILE" "$JS_FILE.backup-$(date +%Y%m%d-%H%M%S)"
cp "$UI_HTML" "$UI_HTML.backup-$(date +%Y%m%d-%H%M%S)"
echo "📦 Created backups"

# --- Patch 1: Thinking toggle bug fix ---
# Hides tool-only assistant messages when thinking is toggled off
if grep -q '!e.showThinking&&l.role.toLowerCase()==="toolresult"' "$JS_FILE"; then
  sedi 's/!e\.showThinking&&l\.role\.toLowerCase()==="toolresult"/!e.showThinking\&\&(l.role.toLowerCase()==="toolresult"||l.role==="assistant"\&\&Array.isArray(o.content)\&\&o.content.length>0\&\&o.content.every(function(cc){var ct=(typeof cc.type==="string"?cc.type:"").toLowerCase();return ct==="toolcall"||ct==="tool_call"||ct==="tooluse"||ct==="tool_use"||ct==="thinking"}))/' "$JS_FILE"
  echo "✅ Patch 1: Thinking toggle bug fix"
else
  echo "⚠️  Patch 1: Already applied or pattern changed"
fi

# --- Patch 2: Enter key on password field triggers Connect ---
if grep -q 'onPasswordChange(l)}}' "$JS_FILE" && ! grep -q 'onPasswordChange.*keydown' "$JS_FILE"; then
  sedi 's|@input=\${o=>{const l=o.target.value;e.onPasswordChange(l)}}|@input=\${o=>{const l=o.target.value;e.onPasswordChange(l)}}\n              @keydown=\${o=>{if(o.key==="Enter"){o.preventDefault();e.onConnect()}}}|' "$JS_FILE"
  if grep -q '@keydown=\${o=>{if(o.key==="Enter")' "$JS_FILE"; then
    echo "✅ Patch 2: Enter key on password field"
  else
    echo "⚠️  Patch 2: Failed to apply"
  fi
else
  echo "⚠️  Patch 2: Already applied or pattern changed"
fi

# --- Patch 3: Auto-switch to Chat tab on connect (onHello) ---
# Works by injecting cu(e,"chat") into the onHello callback
if grep -q 'onHello:t=>{e.connected=!0' "$JS_FILE" && ! grep -q 'cu(e,"chat")' "$JS_FILE"; then
  sedi 's|Zn(e,{quiet:!0}|Zn(e,{quiet:!0});cu(e,"chat"|' "$JS_FILE"
  if grep -q 'cu(e,"chat")' "$JS_FILE"; then
    echo "✅ Patch 3: Auto-switch to Chat on connect"
  else
    echo "⚠️  Patch 3: Failed to apply"
  fi
else
  if grep -q 'cu(e,"chat")' "$JS_FILE"; then
    echo "⚠️  Patch 3: Already applied"
  else
    echo "⚠️  Patch 3: Pattern not found"
  fi
fi

# --- Patch 4: Thinking toggle icon (brain when on, circle when off) ---
if grep -q '${le.brain}' "$JS_FILE" && ! grep -q 'a?le.brain:r' "$JS_FILE"; then
  sedi 's|\${le\.brain}|${a?le.brain:r`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /></svg>`}|' "$JS_FILE"
  if grep -q 'a?le.brain:r' "$JS_FILE"; then
    echo "✅ Patch 4: Thinking icon (brain/circle)"
  else
    echo "⚠️  Patch 4: Failed to apply"
  fi
else
  echo "⚠️  Patch 4: Already applied or pattern changed"
fi

# --- Patch 5: Custom page title ---
if grep -q '<title>OpenClaw Control</title>' "$UI_HTML"; then
  sedi "s/<title>OpenClaw Control<\/title>/<title>$PAGE_TITLE<\/title>/" "$UI_HTML"
  echo "✅ Patch 5: Page title → $PAGE_TITLE"
elif grep -q '<title>.*- OpenClaw Control</title>' "$UI_HTML"; then
  sedi "s/<title>.*- OpenClaw Control<\/title>/<title>$PAGE_TITLE<\/title>/" "$UI_HTML"
  echo "✅ Patch 5: Page title updated → $PAGE_TITLE"
else
  echo "⚠️  Patch 5: Title pattern not found"
fi

echo ""
echo "✨ Patch application complete!"
echo "🔄 Restart the gateway: openclaw gateway restart"
echo ""
echo "Patches:"
echo "  1. Thinking toggle bug fix (hide tool-only messages)"
echo "  2. Enter key on password field triggers Connect"
echo "  3. Auto-switch to Chat tab after connection"
echo "  4. Thinking icon: brain (on) / circle (off)"
echo "  5. Custom page title from hostname"
