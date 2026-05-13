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
    TRAY_UI_REQUEST_CHAT = 2,
} TrayUiRequest;

typedef enum {
    TRAY_UI_ACTION_SHOW_SETTINGS = 0,
    TRAY_UI_ACTION_SHOW_DIAGNOSTICS = 1,
    /*
     * Chat lives in its own window (chat_window.{c,h}) — entirely separate
     * from the settings / diagnostics main window. This action tells tray
     * callers to present the chat window without touching the main one.
     */
    TRAY_UI_ACTION_SHOW_CHAT = 2,
} TrayUiAction;

TrayUiAction tray_ui_dispatch_decide(TrayUiRequest request, gboolean onboarding_visible);

/* ── Chat window lifecycle decisions (from chat_window.c) ─────────── */

typedef enum {
    /* No window exists; caller should build + present a new window. */
    CHAT_WINDOW_ACTION_BUILD_AND_PRESENT = 0,
    /* Singleton exists; caller should present the existing window. */
    CHAT_WINDOW_ACTION_PRESENT_EXISTING = 1,
    /* No GApplication is bound; caller should ignore the request. */
    CHAT_WINDOW_ACTION_IGNORE_NO_APP = 2,
} ChatWindowShowAction;

/*
 * Pure decision helper for `chat_window_show()`. Keeps the UI-agnostic
 * invariants (singleton, application-scoped lifetime) testable without
 * instantiating GTK widgets:
 *
 *   - If `has_application` is FALSE, returns IGNORE_NO_APP regardless of
 *     whether a window already exists.
 *   - Else, if `window_exists` is TRUE, returns PRESENT_EXISTING.
 *   - Else, returns BUILD_AND_PRESENT.
 */
ChatWindowShowAction chat_window_show_decide(gboolean has_application,
                                             gboolean window_exists);

/* ── Onboarding refresh decisions (from onboarding.c) ─────────────── */

typedef struct {
    gint state;
    gint route;
    gint stage_configuration;
    gint stage_service_gateway;
    gint stage_connection;
    gboolean operational_ready;
    gboolean config_valid;
    gboolean setup_detected;
    gboolean sys_installed;
    gboolean sys_active;
    gboolean config_file_exists;
    gboolean state_dir_exists;
    const gchar *next_action;
} OnboardingRefreshSnapshotInput;

typedef enum {
    ONBOARDING_REFRESH_ACTION_NOOP = 0,
    ONBOARDING_REFRESH_ACTION_REBUILD_PAGES = 1,
    ONBOARDING_REFRESH_ACTION_REFRESH_LIVE = 2,
} OnboardingRefreshAction;

gboolean onboarding_refresh_snapshot_equal(const OnboardingRefreshSnapshotInput *a,
                                           const OnboardingRefreshSnapshotInput *b);

OnboardingRefreshAction onboarding_refresh_action_decide(gboolean snapshots_equal,
                                                         gboolean route_changed);

#endif /* TEST_SEAMS_H */
