#!/bin/bash
# Claude Code → MAIBOT Discord DM notification hook
# Pipes stdin JSON to Node.js script for parsing and sending
cd "C:/MAIBOT" && node .claude/hooks/notify-discord.mjs
exit 0
