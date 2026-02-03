#!/bin/bash
# Restart Moltbot gateway on macOS wake from sleep.
# Called by a SleepWatcher or loginwindow hook.
sleep 5  # wait for network to come up
/opt/homebrew/bin/moltbot gateway restart --reason "macOS wake from sleep" 2>/dev/null || \
  launchctl kickstart -k "gui/$(id -u)/bot.molt.gateway" 2>/dev/null
