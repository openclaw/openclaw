/*
 * runtime_reveal.h
 *
 * Shared "reveal" URI builders for the Linux companion app.
 *
 * Every main-window section that exposes a "Reveal Config Folder" or
 * "Reveal State Folder" affordance must resolve the *effective* runtime
 * paths via the same precedence contract as `runtime_paths.h`. This
 * module composes the live runtime context (systemd profile/state
 * directory/config path) and the currently loaded gateway config into a
 * single call that returns a `file://` URI ready for
 * `g_app_info_launch_default_for_uri`.
 *
 * Kept in a separate translation unit so `runtime_paths.c` stays a pure
 * leaf module that headless tests can link without stubbing systemd /
 * gateway-client seams.
 *
 * Ownership contract: returned URIs are newly allocated and must be
 * freed by the caller (g_free).
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>

/* Builds a file:// URI pointing to the directory that contains the
 * effective config path (loaded gateway config path, else resolved
 * runtime config path, else raw runtime config path), or NULL if no
 * effective config path can be determined. */
gchar* runtime_reveal_build_config_dir_uri(void);

/* Builds a file:// URI pointing to the effective state directory
 * (runtime state dir, else dirname(effective config path)), or NULL
 * if no effective state directory can be determined. */
gchar* runtime_reveal_build_state_dir_uri(void);
