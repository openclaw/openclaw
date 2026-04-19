/*
 * device_pair_request_info.c
 *
 * Pure-C allocator / destructor for OcPairRequestInfo. Split from the
 * GTK/Adw-based approval window so that headless tests (and non-UI code
 * paths) can own the struct without pulling in GTK linkage.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "device_pair_approval_window.h"

#include <glib.h>

OcPairRequestInfo* oc_pair_request_info_new(const gchar  *request_id,
                                            const gchar  *client_id,
                                            const gchar  *platform,
                                            const gchar  *display_name,
                                            const gchar  *host_address,
                                            const gchar  *requester_device_id,
                                            const gchar * const *scopes)
{
    OcPairRequestInfo *info = g_new0(OcPairRequestInfo, 1);
    info->request_id  = g_strdup(request_id  ? request_id  : "");
    info->client_id   = g_strdup(client_id   ? client_id   : "");
    info->platform    = g_strdup(platform    ? platform    : "");
    info->display_name= g_strdup(display_name? display_name: "");
    info->host_address= g_strdup(host_address? host_address: "");
    info->requester_device_id = g_strdup(requester_device_id ? requester_device_id : "");

    gsize n = 0;
    if (scopes) while (scopes[n]) n++;
    info->scopes = g_new0(gchar *, n + 1);
    for (gsize i = 0; i < n; i++) info->scopes[i] = g_strdup(scopes[i]);
    return info;
}

void oc_pair_request_info_free(OcPairRequestInfo *info) {
    if (!info) return;
    g_free(info->request_id);
    g_free(info->client_id);
    g_free(info->platform);
    g_free(info->display_name);
    g_free(info->host_address);
    g_free(info->requester_device_id);
    g_strfreev(info->scopes);
    g_free(info);
}

/*
 * Append `raw` escaped into `out` with markup-safe entities. A NULL or
 * empty raw is a no-op (the caller's outer template handles the
 * "field absent" case). Uses `g_markup_escape_text` so `<`, `>`, `&`,
 * single-quote and double-quote become entity references.
 */
static void append_escaped(GString *out, const gchar *raw) {
    if (!raw || !raw[0]) return;
    g_autofree gchar *esc = g_markup_escape_text(raw, -1);
    if (esc) g_string_append(out, esc);
}

gchar* oc_pair_approval_build_body_markup(const OcPairRequestInfo *info) {
    GString *g = g_string_new(NULL);
    if (!info) return g_string_free(g, FALSE);

    /*
     * Every interpolation site below must escape dynamic content. The
     * only raw markup allowed is the app-authored wrapper tags.
     */
    if (info->display_name && info->display_name[0]) {
        g_string_append(g, "<b>");
        append_escaped(g, info->display_name);
        g_string_append(g, "</b>\n");
    }
    if (info->client_id && info->client_id[0]) {
        g_string_append(g, "Client: ");
        append_escaped(g, info->client_id);
        g_string_append_c(g, '\n');
    }
    if (info->platform && info->platform[0]) {
        g_string_append(g, "Platform: ");
        append_escaped(g, info->platform);
        g_string_append_c(g, '\n');
    }
    if (info->host_address && info->host_address[0]) {
        g_string_append(g, "From: ");
        append_escaped(g, info->host_address);
        g_string_append_c(g, '\n');
    }
    if (info->scopes && info->scopes[0]) {
        g_string_append(g, "Scopes:\n");
        for (gsize i = 0; info->scopes[i]; i++) {
            g_string_append(g, "  \xe2\x80\xa2 "); /* U+2022 BULLET */
            append_escaped(g, info->scopes[i]);
            g_string_append_c(g, '\n');
        }
    }
    return g_string_free(g, FALSE);
}
