#!/bin/bash
git checkout --ours extensions/feishu/src/bot.ts
git checkout --ours apps/macos/Sources/OpenClaw/GeneralSettings.swift
git checkout --ours apps/macos/Sources/OpenClaw/OnboardingView+Pages.swift
git checkout --ours apps/macos/Sources/OpenClaw/SystemRunSettingsView.swift
git checkout --ours apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatMessageViews.swift
git checkout --ours apps/macos/Sources/OpenClaw/AnthropicAuthControls.swift
git rm scripts/bundle-a2ui.sh 2>/dev/null
git add apps/ extensions/ scripts/
