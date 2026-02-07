#!/bin/bash
# Reapply Control UI patches after OpenClaw updates
# Run this after: npm update -g openclaw

UI_JS="/opt/homebrew/lib/node_modules/openclaw/dist/control-ui/assets/index-*.js"
UI_HTML="/opt/homebrew/lib/node_modules/openclaw/dist/control-ui/index.html"

echo "🔧 Reapplying Control UI patches..."

# Find the actual JS file (name includes hash)
JS_FILE=$(ls $UI_JS 2>/dev/null | head -1)

if [ -z "$JS_FILE" ]; then
  echo "❌ Could not find Control UI JS file"
  exit 1
fi

echo "📁 Found: $JS_FILE"

# Backup
cp "$JS_FILE" "$JS_FILE.backup-$(date +%Y%m%d-%H%M%S)"
cp "$UI_HTML" "$UI_HTML.backup-$(date +%Y%m%d-%H%M%S)"

echo "📦 Created backups"

# --- Patch 1: Thinking toggle bug fix ---
if grep -q '!e.showThinking&&l.role.toLowerCase()==="toolresult"' "$JS_FILE"; then
  sed -i '' 's/!e\.showThinking&&l\.role\.toLowerCase()==="toolresult"/!e.showThinking\&\&(l.role.toLowerCase()==="toolresult"||l.role==="assistant"\&\&Array.isArray(o.content)\&\&o.content.length>0\&\&o.content.every(function(cc){var ct=(typeof cc.type==="string"?cc.type:"").toLowerCase();return ct==="toolcall"||ct==="tool_call"||ct==="tooluse"||ct==="tool_use"||ct==="thinking"}))/' "$JS_FILE"
  echo "✅ Patch 1: Thinking toggle bug fix"
else
  echo "⚠️  Patch 1: Already applied or pattern changed"
fi

# --- Patch 2: Enter key on password field ---
if grep -q '@input=\${o=>{const l=o.target.value;e.onPasswordChange(l)}}' "$JS_FILE" && ! grep -q '@keydown=\${o=>{if(o.key==="Enter")' "$JS_FILE"; then
  sed -i '' 's/@input=\${o=>{const l=o.target.value;e.onPasswordChange(l)}}/@input=\${o=>{const l=o.target.value;e.onPasswordChange(l)}}\
              @keydown=\${o=>{if(o.key==="Enter"){o.preventDefault();e.onConnect()}}}/' "$JS_FILE"
  echo "✅ Patch 2: Enter key on password field"
else
  echo "⚠️  Patch 2: Already applied or pattern changed"
fi

# --- Patch 3: Auto-switch to Chat on connection (onHello callback) ---
if grep -q 'onHello:t=>{e.connected=!0,e.lastError=null,e.hello=t,dg(e,t),e.chatRunId=null,e.chatStream=null,e.chatStreamStartedAt=null,is(e),el(e),Mi(e),Zn(e,{quiet:!0}),Ze(e,{quiet:!0}),zi(e)}' "$JS_FILE"; then
  sed -i '' 's/onHello:t=>{e.connected=!0,e.lastError=null,e.hello=t,dg(e,t),e.chatRunId=null,e.chatStream=null,e.chatStreamStartedAt=null,is(e),el(e),Mi(e),Zn(e,{quiet:!0}),Ze(e,{quiet:!0}),zi(e)}/onHello:t=>{e.connected=!0,e.lastError=null,e.hello=t,dg(e,t),e.chatRunId=null,e.chatStream=null,e.chatStreamStartedAt=null,is(e),el(e),Mi(e),Zn(e,{quiet:!0}),Ze(e,{quiet:!0}),e.tab==="overview"\&\&cu(e,"chat"),zi(e)}/' "$JS_FILE"
  echo "✅ Patch 3: Auto-switch to Chat after connection"
else
  echo "⚠️  Patch 3: Already applied or pattern changed"
fi

# --- Patch 4: Thinking toggle icon state ---
if grep -q 'title=\${s?"Disabled during onboarding":"Toggle assistant thinking/working output"}' "$JS_FILE" && grep -q '\${le.brain}' "$JS_FILE"; then
  # Update the button to show different icons and tooltips
  sed -i '' 's/title=\${s?"Disabled during onboarding":"Toggle assistant thinking\/working output"}/title=\${s?"Disabled during onboarding":(a?"Hide assistant thinking\/working output":"Show assistant thinking\/working output")}/' "$JS_FILE"
  sed -i '' 's/\${le.brain}\
      <\/button>/\${a?le.brain:le.circle}\
      <\/button>/' "$JS_FILE"
  echo "✅ Patch 4: Thinking toggle icon state"
else
  echo "⚠️  Patch 4: Already applied or pattern changed"
fi

# --- Patch 5: Custom page title ---
if grep -q '<title>OpenClaw Control</title>' "$UI_HTML"; then
  sed -i '' 's/<title>OpenClaw Control<\/title>/<title>MacOS VM - OpenClaw Control<\/title>/' "$UI_HTML"
  echo "✅ Patch 5: Custom page title"
else
  echo "⚠️  Patch 5: Already applied or pattern changed"
fi

echo ""
echo "✨ Patch application complete!"
echo "🔄 Restart the gateway: openclaw gateway restart"
echo ""
echo "Applied patches:"
echo "  • Thinking toggle bug fix (PR #10996)"
echo "  • Enter key connects to gateway"
echo "  • Auto-switch to Chat view after connection"
echo "  • Thinking toggle icon state (brain/circle)"
echo "  • Custom page title"
