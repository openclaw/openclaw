/*
 * test_seams.c
 *
 * Test seam helpers extracted from production code for unit testing.
 * These are pure functions with no GTK/RPC dependencies.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "test_seams.h"
#include <string.h>

/* ── Cron sessionTarget mapping (from section_cron.c) ───────────────
 *
 * These helpers allow unit testing the index<->sessionTarget
 * conversion logic without needing GTK widgets.
 */

/* Convert combo row index to sessionTarget wire value.
 * Index 0 = "New Session"    -> "isolated"
 * Index 1 = "Main Session"   -> "main"
 * Index 2 = "Current Session" -> "current"
 * Index 3 = "Isolated Session" -> "isolated"
 */
const gchar* session_target_from_index(gint idx) {
    switch (idx) {
        case 1: return "main";
        case 2: return "current";
        case 0:
        case 3: return "isolated";
        default: return "isolated";
    }
}

/* Convert persisted sessionTarget value to combo row index.
 * "main"     -> 1 (Main Session)
 * "current"  -> 2 (Current Session)
 * "isolated" -> 3 (Isolated Session)
 * NULL/unknown -> 0 (New Session)
 */
int session_target_to_index(const gchar *target) {
    if (!target) return 0;
    if (strcmp(target, "main") == 0) return 1;
    if (strcmp(target, "current") == 0) return 2;
    if (strcmp(target, "isolated") == 0) return 3;
    return 0; /* default to New Session for unknown values */
}

/* ── QR login payload handling (from section_channels.c) ─────────────
 *
 * This helper extracts the core payload inspection logic from
 * on_web_login_start_done so it can be unit tested without GTK.
 *
 * Returns TRUE if the payload indicates QR should be shown
 * (qrDataUrl present and non-empty), FALSE otherwise.
 * The out_qr_data_url pointer is set to the qrDataUrl value if present.
 */
#include <json-glib/json-glib.h>

int web_login_start_payload_has_qr(JsonObject *payload_obj,
                                    const gchar **out_qr_data_url) {
    if (!payload_obj) {
        if (out_qr_data_url) *out_qr_data_url = NULL;
        return 0;
    }

    /* Check for qrDataUrl - it's optional per the channel adapter contract.
     * If present and non-empty, QR should be shown; otherwise proceed directly.
     */
    const gchar *qr_data_url = NULL;
    if (json_object_has_member(payload_obj, "qrDataUrl")) {
        qr_data_url = json_object_get_string_member(payload_obj, "qrDataUrl");
    }

    if (out_qr_data_url) *out_qr_data_url = qr_data_url;
    return (qr_data_url && *qr_data_url != '\0') ? 1 : 0;
}
