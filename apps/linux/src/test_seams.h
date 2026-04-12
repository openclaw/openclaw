/*
 * test_seams.h
 *
 * Test seam helpers extracted from production code for unit testing.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef TEST_SEAMS_H
#define TEST_SEAMS_H

#include <glib.h>

/* Forward declaration for json-glib */
struct _JsonObject;
typedef struct _JsonObject JsonObject;

/* ── Cron sessionTarget mapping (from section_cron.c) ─────────────── */

/* Convert combo row index to sessionTarget wire value.
 * Index 0 = "New Session"    -> "isolated"
 * Index 1 = "Main Session"   -> "main"
 * Index 2 = "Current Session" -> "current"
 * Index 3 = "Isolated Session" -> "isolated"
 */
const gchar* session_target_from_index(gint idx);

/* Convert persisted sessionTarget value to combo row index.
 * "main"     -> 1 (Main Session)
 * "current"  -> 2 (Current Session)
 * "isolated" -> 3 (Isolated Session)
 * NULL/unknown -> 0 (New Session)
 */
gint session_target_to_index(const gchar *target);

/* ── QR login payload handling (from section_channels.c) ───────────── */

/* Returns TRUE (non-zero) if the payload indicates QR should be shown
 * (qrDataUrl present and non-empty), FALSE (0) otherwise.
 * The out_qr_data_url pointer is set to the qrDataUrl value if present.
 */
int web_login_start_payload_has_qr(JsonObject *payload_obj,
                                      const gchar **out_qr_data_url);

/* ── Config monitor rearm decision logic (from gateway_client.c) ──── */

/* Pure helper for testing rearm decision logic without GFileMonitor machinery.
 * Returns TRUE if rearm can be skipped given the current state.
 */
gboolean config_monitor_can_skip_rearm(
    const gchar *new_dir,
    const gchar *old_dir,
    const gchar *new_path,
    const gchar *old_path,
    gboolean have_dir_monitor,
    gboolean need_file_monitor,
    gboolean have_file_monitor);

/* Pure helper to find the nearest existing ancestor directory.
 * Used for fallback monitoring when the config directory doesn't exist yet.
 * Returns a newly allocated string with the path, or NULL if none found.
 */
gchar* find_nearest_existing_ancestor(const gchar *path);

/* ── Tray dispatch decisions (from tray.c) ────────────────────────── */

typedef enum {
    TRAY_UI_REQUEST_SETTINGS = 0,
    TRAY_UI_REQUEST_DIAGNOSTICS = 1,
} TrayUiRequest;

typedef enum {
    TRAY_UI_ACTION_SHOW_SETTINGS = 0,
    TRAY_UI_ACTION_SHOW_DIAGNOSTICS = 1,
} TrayUiAction;

TrayUiAction tray_ui_dispatch_decide(TrayUiRequest request, gboolean onboarding_visible);

#endif /* TEST_SEAMS_H */
