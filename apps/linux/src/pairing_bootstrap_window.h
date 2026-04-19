/*
 * pairing_bootstrap_window.h
 *
 * Native Linux fallback surface shown when the gateway rejects connect with
 * detail code `PAIRING_REQUIRED`. The Linux companion is a first-class
 * approver surface of its own — the usual resolution path is:
 *
 *   1. silent first-run pair (no UI at all), or
 *   2. local CLI approval on *this* machine:
 *        openclaw devices pair approve <requestId>
 *   3. optional: approve from another authorized operator surface
 *      (e.g. Control UI in a browser, macOS companion) if one is
 *      already paired and reachable.
 *
 * Presentation contract:
 *   - singleton: only one bootstrap window is visible at a time.
 *   - the window embeds the pending request id and this machine's device id
 *     so the operator can cross-check before approving.
 *   - the CLI fallback command is rendered literally and copy-to-clipboardable.
 *   - "Check again" resumes the WS reconnect by invoking
 *     `gateway_ws_resume_after_pairing_approved()`.
 *   - "Dismiss" closes the window but does NOT resume the transport; the
 *     companion will remain paused until the operator re-opens it.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_PAIRING_BOOTSTRAP_WINDOW_H
#define OPENCLAW_LINUX_PAIRING_BOOTSTRAP_WINDOW_H

#include <gtk/gtk.h>

/*
 * Present (or bring-to-front) the singleton bootstrap window.
 *
 * parent          : may be NULL.
 * request_id      : pending pair request id reported by the gateway
 *                   (e.g. propagated via PAIRING_REQUIRED detail). May be
 *                   NULL or empty if the handshake error carried no
 *                   request id.
 * device_id       : this machine's deviceId (lowercase-hex SHA-256 of the
 *                   raw public key). May be NULL/empty.
 * detail_message  : free-form status copy (e.g. gateway error text).
 *                   Rendered separately from the actionable request info.
 *
 * Non-clobber contract for updates:
 *   If the window is already on screen, each of {request_id, device_id,
 *   detail_message} is honored only when non-NULL AND non-empty. Passing
 *   NULL or "" preserves whatever the window was already displaying.
 *   This is critical because the tray "Pairing…" action and other
 *   re-present paths may not have a fresh copy of the actionable
 *   metadata; they must not downgrade it.
 *
 *   If no non-empty request_id has ever been provided, the CLI fallback
 *   section shows `openclaw devices pair list` as a discovery hint. Once
 *   any non-empty request_id has been surfaced, subsequent NULL/empty
 *   values never revert the displayed command.
 */
void pairing_bootstrap_window_show(GtkWindow   *parent,
                                   const gchar *request_id,
                                   const gchar *device_id,
                                   const gchar *detail_message);

/*
 * Raise-only: bring the existing bootstrap window to the foreground
 * without mutating any cached state. No-op when the window is not
 * currently on screen. Idempotent and safe to call from tray handlers
 * that don't have access to the original gateway metadata.
 */
void pairing_bootstrap_window_raise(void);

/* Close the bootstrap window if visible. */
void pairing_bootstrap_window_hide(void);

/* Whether the bootstrap window is currently on screen. */
gboolean pairing_bootstrap_window_is_visible(void);

/*
 * Test seams — read-only accessors for the cached state of the visible
 * bootstrap window. Return NULL when the window is not on screen or the
 * corresponding field has never been supplied as a non-empty value.
 * Returned pointers are owned by the window and remain valid only until
 * the next show()/hide() call.
 */
const gchar* pairing_bootstrap_window_current_request_id(void);
const gchar* pairing_bootstrap_window_current_device_id(void);
const gchar* pairing_bootstrap_window_current_detail(void);
const gchar* pairing_bootstrap_window_current_cli_command(void);

/*
 * Test seam: exercise the cache-ingest + cli-command computation path
 * WITHOUT constructing any GTK widgets. Mirrors the update phase of
 * `pairing_bootstrap_window_show()`, including the non-clobber contract:
 * NULL/empty arguments are ignored. Used by the headless unit tests so
 * they don't depend on gtk_init() or an X/Wayland display.
 */
void pairing_bootstrap_window_test_update_state(const gchar *request_id,
                                                const gchar *device_id,
                                                const gchar *detail_message);

/*
 * Test seam: release all cached state (request_id / device_id /
 * detail / cli_command). Models the on-destroy cleanup that runs when
 * the real window is closed, so a subsequent test_update_state() call
 * simulates a fresh hide-then-reshow cycle.
 */
void pairing_bootstrap_window_test_clear_state(void);

/*
 * Build the Linux CLI fallback command for the given request id.
 * Returns a newly allocated string of the form:
 *
 *   openclaw devices pair approve <requestId>
 *
 * or, when request_id is NULL / empty:
 *
 *   openclaw devices pair list
 *
 * Exposed for tests and for the tray's copy-to-clipboard action.
 * Caller frees with g_free().
 */
gchar* pairing_bootstrap_cli_command_for_request(const gchar *request_id);

#endif /* OPENCLAW_LINUX_PAIRING_BOOTSTRAP_WINDOW_H */
