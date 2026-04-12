/*
 * onboarding.h
 *
 * State-aware onboarding flow for the OpenClaw Linux Companion App.
 *
 * A guided first-run and recovery flow that adapts to the detected
 * gateway state. Capable of short-circuiting when the gateway is
 * already healthy. Re-openable later from the app.
 *
 * Lifecycle:
 *   - Auto-appears on first launch or when onboarding version bumps
 *   - Shortened flow when gateway is already healthy on first run
 *   - Full guidance when setup/install/config issues detected
 *   - Dismissed by completing the flow; writes version marker
 *   - Re-openable from General or Environment sections
 *
 * Tray-first behavior: after onboarding is completed, the app remains
 * tray-first. The main window does not auto-open on every launch.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>

#define ONBOARDING_CURRENT_VERSION 1

void onboarding_check_and_show(void);
void onboarding_show(void);
void onboarding_refresh(void);
void onboarding_reset(void);
int onboarding_get_seen_version(void);
gboolean onboarding_is_visible(void);
