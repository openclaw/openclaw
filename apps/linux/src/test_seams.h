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

#endif /* TEST_SEAMS_H */
