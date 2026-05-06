/*
 * remote_endpoint.c
 *
 * See header for contract. Implementation keeps a single canonical
 * snapshot and broadcasts subscribe-style notifications whenever any
 * field changes. All operations happen on the GLib main context.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "remote_endpoint.h"

#include <string.h>

#include "log.h"

typedef struct {
    guint id;
    RemoteEndpointChangedFn cb;
    gpointer user_data;
} Subscriber;

typedef struct {
    RemoteEndpointStateKind kind;
    gchar *host;
    gint   port;
    gboolean tls;
    gchar *token;
    gchar *password;
    gchar *detail;
} EndpointStore;

static EndpointStore g_store = { .kind = REMOTE_ENDPOINT_IDLE };
static RemoteEndpointSnapshot g_snapshot;
static GArray *g_subs = NULL;  /* GArray of Subscriber */
static guint g_next_sub_id = 1;
static gboolean g_initialized = FALSE;

static void secure_clear_free(gchar *s) {
    if (!s) return;
    volatile gchar *p = s;
    while (*p) *p++ = '\0';
    g_free(s);
}

static void rebuild_snapshot(void) {
    g_snapshot.kind = g_store.kind;
    g_snapshot.host = g_store.host;
    g_snapshot.port = g_store.port;
    g_snapshot.tls  = g_store.tls;
    g_snapshot.token    = g_store.token;
    g_snapshot.password = g_store.password;
    g_snapshot.detail = g_store.detail;
}

static void notify_subscribers(void) {
    if (!g_subs) return;
    /* Snapshot subscribers first so a handler that unsubscribes itself
     * cannot invalidate our iteration. */
    guint n = g_subs->len;
    Subscriber *copy = g_new(Subscriber, n);
    memcpy(copy, g_subs->data, sizeof(Subscriber) * n);
    for (guint i = 0; i < n; i++) {
        if (copy[i].cb) copy[i].cb(copy[i].user_data);
    }
    g_free(copy);
}

static void publish(void) {
    rebuild_snapshot();
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_REMOTE,
                 "remote_endpoint state=%s host=%s port=%d tls=%d detail=%s",
                 remote_endpoint_state_to_string(g_store.kind),
                 g_store.host ? g_store.host : "(null)",
                 g_store.port,
                 g_store.tls,
                 g_store.detail ? g_store.detail : "(null)");
    notify_subscribers();
}

void remote_endpoint_init(void) {
    if (g_initialized) return;
    g_initialized = TRUE;
    g_subs = g_array_new(FALSE, FALSE, sizeof(Subscriber));
    g_store.kind = REMOTE_ENDPOINT_IDLE;
    rebuild_snapshot();
}

void remote_endpoint_shutdown(void) {
    if (!g_initialized) return;
    g_initialized = FALSE;
    g_clear_pointer(&g_store.host, g_free);
    g_clear_pointer(&g_store.detail, g_free);
    g_clear_pointer(&g_store.token, (GDestroyNotify)secure_clear_free);
    g_clear_pointer(&g_store.password, (GDestroyNotify)secure_clear_free);
    g_store.port = 0;
    g_store.tls = FALSE;
    g_store.kind = REMOTE_ENDPOINT_IDLE;
    if (g_subs) {
        g_array_free(g_subs, TRUE);
        g_subs = NULL;
    }
}

void remote_endpoint_set_local(void) {
    if (!g_initialized) remote_endpoint_init();
    g_clear_pointer(&g_store.host, g_free);
    g_clear_pointer(&g_store.detail, g_free);
    g_clear_pointer(&g_store.token, (GDestroyNotify)secure_clear_free);
    g_clear_pointer(&g_store.password, (GDestroyNotify)secure_clear_free);
    g_store.port = 0;
    g_store.tls = FALSE;
    g_store.kind = REMOTE_ENDPOINT_IDLE;
    publish();
}

void remote_endpoint_set_remote_direct_ready(const gchar *host,
                                             gint         port,
                                             gboolean     tls,
                                             const gchar *token,
                                             const gchar *password) {
    if (!g_initialized) remote_endpoint_init();
    g_clear_pointer(&g_store.host, g_free);
    g_clear_pointer(&g_store.detail, g_free);
    g_clear_pointer(&g_store.token, (GDestroyNotify)secure_clear_free);
    g_clear_pointer(&g_store.password, (GDestroyNotify)secure_clear_free);
    g_store.host = g_strdup(host ? host : "");
    g_store.port = port;
    g_store.tls = tls;
    g_store.token = token ? g_strdup(token) : NULL;
    g_store.password = password ? g_strdup(password) : NULL;
    g_store.kind = REMOTE_ENDPOINT_READY;
    publish();
}

void remote_endpoint_set_remote_ssh_ready(gint local_port,
                                          const gchar *token,
                                          const gchar *password) {
    if (!g_initialized) remote_endpoint_init();
    g_clear_pointer(&g_store.host, g_free);
    g_clear_pointer(&g_store.detail, g_free);
    g_clear_pointer(&g_store.token, (GDestroyNotify)secure_clear_free);
    g_clear_pointer(&g_store.password, (GDestroyNotify)secure_clear_free);
    g_store.host = g_strdup("127.0.0.1");
    g_store.port = local_port;
    g_store.tls = FALSE;
    g_store.token = token ? g_strdup(token) : NULL;
    g_store.password = password ? g_strdup(password) : NULL;
    g_store.kind = REMOTE_ENDPOINT_READY;
    publish();
}

static void clear_ready_fields(void) {
    g_clear_pointer(&g_store.host, g_free);
    g_clear_pointer(&g_store.token, (GDestroyNotify)secure_clear_free);
    g_clear_pointer(&g_store.password, (GDestroyNotify)secure_clear_free);
    g_store.port = 0;
    g_store.tls = FALSE;
}

void remote_endpoint_set_connecting(const gchar *detail) {
    if (!g_initialized) remote_endpoint_init();
    /*
     * CONNECTING/UNAVAILABLE must NOT retain stale READY data. The
     * transport rebuilder gates on kind == READY, but defensive clearing
     * eliminates any chance a future caller mis-uses the snapshot.
     */
    clear_ready_fields();
    g_clear_pointer(&g_store.detail, g_free);
    g_store.detail = g_strdup(detail ? detail : "Connecting…");
    g_store.kind = REMOTE_ENDPOINT_CONNECTING;
    publish();
}

void remote_endpoint_set_unavailable(const gchar *reason) {
    if (!g_initialized) remote_endpoint_init();
    clear_ready_fields();
    g_clear_pointer(&g_store.detail, g_free);
    g_store.detail = g_strdup(reason ? reason : "Unavailable");
    g_store.kind = REMOTE_ENDPOINT_UNAVAILABLE;
    publish();
}

const RemoteEndpointSnapshot* remote_endpoint_get(void) {
    if (!g_initialized) remote_endpoint_init();
    return &g_snapshot;
}

guint remote_endpoint_subscribe(RemoteEndpointChangedFn cb, gpointer user_data) {
    if (!g_initialized) remote_endpoint_init();
    if (!cb) return 0;
    Subscriber s = { .id = g_next_sub_id++, .cb = cb, .user_data = user_data };
    g_array_append_val(g_subs, s);
    return s.id;
}

void remote_endpoint_unsubscribe(guint subscription_id) {
    if (!g_initialized || !g_subs || subscription_id == 0) return;
    for (guint i = 0; i < g_subs->len; i++) {
        Subscriber *s = &g_array_index(g_subs, Subscriber, i);
        if (s->id == subscription_id) {
            g_array_remove_index(g_subs, i);
            return;
        }
    }
}

const gchar* remote_endpoint_state_to_string(RemoteEndpointStateKind kind) {
    switch (kind) {
    case REMOTE_ENDPOINT_IDLE:        return "idle";
    case REMOTE_ENDPOINT_CONNECTING:  return "connecting";
    case REMOTE_ENDPOINT_READY:       return "ready";
    case REMOTE_ENDPOINT_UNAVAILABLE: return "unavailable";
    default:                          return "unknown";
    }
}
