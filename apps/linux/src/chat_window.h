/*
 * chat_window.h
 *
 * Dedicated Chat window for the OpenClaw Linux Companion App.
 *
 * Matches the macOS companion pattern (WebChatManager + WebChatSwiftUIWindowController):
 * chat is presented as a first-class, standalone window that lives entirely
 * outside of the main (settings / diagnostics / management) window. The main
 * window does not embed chat content; the chat window does not embed
 * settings. They are independent surfaces with independent lifecycles.
 *
 * The chat window owns its own `ChatController` instance (see
 * chat_controller.{c,h}) and drives it directly: build() returns the
 * scrolled widget tree, refresh() / destroy() / invalidate() are called
 * from this window's own refresh timer and lifecycle. No singleton
 * SectionController accessor is involved; the main settings window
 * does not embed or coordinate the chat UI.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_CHAT_WINDOW_H
#define OPENCLAW_LINUX_CHAT_WINDOW_H

#include <gtk/gtk.h>

/*
 * Create (if needed) and present the singleton chat window. Idempotent:
 * subsequent calls bring the existing window to front without rebuilding
 * the chat widget or its RPC subscriptions.
 */
void chat_window_show(void);

/* Close the chat window if visible; tears down its refresh timer and calls
 * the chat controller's destroy() to free per-session state. */
void chat_window_hide(void);

/* TRUE when the chat window currently exists. */
gboolean chat_window_is_visible(void);

#endif /* OPENCLAW_LINUX_CHAT_WINDOW_H */
