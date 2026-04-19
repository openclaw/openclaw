/*
 * chat_controller.h
 *
 * Instance-backed chat controller for the OpenClaw Linux Companion App.
 *
 * Unlike the sidebar-driven sections in the main settings window (which
 * share the `SectionController` vtable and live behind a module-level
 * singleton accessor), chat is owned directly by its host window
 * (`chat_window.c`). This header exposes the controller lifecycle so the
 * host can:
 *
 *   1. construct a controller instance bound to a specific window,
 *   2. build its widget tree,
 *   3. drive periodic refresh,
 *   4. invalidate cached data after a mutation,
 *   5. destroy it on window close.
 *
 * Only one `ChatController` instance may be live at a time. The internal
 * gateway event subscription, RPC request registry, and session-scoped
 * streaming state assume a single owner; attempting to construct a
 * second instance while the first is still alive returns NULL. Callers
 * that want to re-open the chat window after closing it MUST destroy the
 * prior instance first.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <gtk/gtk.h>
#include <glib.h>

typedef struct ChatController ChatController;

/*
 * Allocate a fresh controller. Returns NULL if another controller is
 * already live; the caller must `chat_controller_destroy()` that one
 * first.
 */
ChatController* chat_controller_new(void);

/*
 * Build the chat widget tree. Returns a floating widget owned by the
 * caller (typically embedded under an AdwToolbarView). Safe to call
 * once per controller instance.
 */
GtkWidget* chat_controller_build(ChatController *self);

/*
 * Re-fetch data if stale. Honors the shared SECTION_FRESH_INTERVAL_US
 * TTL; no-op when data is fresh. Safe to call from a GSource tick.
 */
void chat_controller_refresh(ChatController *self);

/*
 * Mark cached state stale so the next refresh forces a re-fetch.
 * Called by the host after a successful mutation.
 */
void chat_controller_invalidate(ChatController *self);

/*
 * Tear down gateway subscriptions, cancel in-flight requests, release
 * all owned state, and free the controller itself. After this call the
 * pointer is invalid.
 */
void chat_controller_destroy(ChatController *self);
