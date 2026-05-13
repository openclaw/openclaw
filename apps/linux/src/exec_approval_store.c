/*
 * exec_approval_store.c
 *
 * JSON-backed quick-mode policy store with refreshable state-dir
 * resolution. See header for the on-disk schema and lifecycle contract.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "exec_approval_store.h"

#include "json_access.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <gio/gio.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>
#include <string.h>
#include <unistd.h>

#define EXEC_APPROVAL_STORE_FILENAME  "exec-approvals.json"
#define EXEC_APPROVAL_STORE_VERSION   1

static gchar          *g_state_dir = NULL;
static gchar          *g_storage_path_override = NULL;
static OcExecQuickMode g_cached_mode = OC_EXEC_QUICK_MODE_ASK;
static gboolean        g_loaded = FALSE;
static gboolean        g_dirty  = FALSE;

/*
 * Carry-through node for keys this tranche does not edit (e.g. `agents`,
 * `socket`). We preserve them on round-trip so a Linux operator who only
 * touches the quick mode cannot accidentally drop policy data written by
 * macOS or by a future Linux UI surface.
 */
static JsonNode *g_full_doc = NULL;

static void quick_mode_to_strings(OcExecQuickMode mode,
                                  const gchar **out_security,
                                  const gchar **out_ask) {
    switch (mode) {
    case OC_EXEC_QUICK_MODE_DENY:
        if (out_security) *out_security = "deny";
        if (out_ask)      *out_ask      = "off";
        return;
    case OC_EXEC_QUICK_MODE_ALLOW:
        if (out_security) *out_security = "full";
        if (out_ask)      *out_ask      = "off";
        return;
    case OC_EXEC_QUICK_MODE_ASK:
    default:
        if (out_security) *out_security = "allowlist";
        if (out_ask)      *out_ask      = "on-miss";
        return;
    }
}

/*
 * Mirror of macOS `ExecApprovalQuickMode.from(security:ask:)`. The mode
 * collapses across both axes; "ask" only meaningfully separates Deny vs
 * Ask when security is allowlist, otherwise security wins.
 */
static OcExecQuickMode quick_mode_from_strings(const gchar *security,
                                               const gchar *ask) {
    (void)ask;
    if (g_strcmp0(security, "deny") == 0) return OC_EXEC_QUICK_MODE_DENY;
    if (g_strcmp0(security, "full") == 0) return OC_EXEC_QUICK_MODE_ALLOW;
    /* Default and "allowlist" both map to Ask. */
    return OC_EXEC_QUICK_MODE_ASK;
}

static gchar* resolve_storage_path(void) {
    if (g_storage_path_override) return g_strdup(g_storage_path_override);
    if (!g_state_dir || g_state_dir[0] == '\0') return NULL;
    return g_build_filename(g_state_dir, EXEC_APPROVAL_STORE_FILENAME, NULL);
}

static gboolean ensure_parent_dir(const gchar *path) {
    g_autofree gchar *dir = g_path_get_dirname(path);
    if (!dir) return FALSE;
    if (g_mkdir_with_parents(dir, 0700) != 0 && errno != EEXIST) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec-approval-store: mkdir %s failed: %s",
                    dir, g_strerror(errno));
        return FALSE;
    }
    (void)g_chmod(dir, 0700);
    return TRUE;
}

static void replace_full_doc(JsonNode *node) {
    if (g_full_doc) {
        json_node_unref(g_full_doc);
        g_full_doc = NULL;
    }
    g_full_doc = node;
}

static JsonNode* build_default_doc(void) {
    JsonObject *root = json_object_new();
    json_object_set_int_member(root, "version", EXEC_APPROVAL_STORE_VERSION);
    JsonObject *defaults = json_object_new();
    const gchar *sec = NULL, *ask = NULL;
    quick_mode_to_strings(g_cached_mode, &sec, &ask);
    json_object_set_string_member(defaults, "security", sec);
    json_object_set_string_member(defaults, "ask", ask);
    json_object_set_object_member(root, "defaults", defaults);
    JsonNode *node = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(node, root);
    return node;
}

/*
 * Reset the in-memory document AND cached quick-mode to the safe
 * default (ASK).
 *
 * Used whenever a load yields no usable on-disk policy: missing file,
 * corrupt JSON, or a non-object root. Critically, this MUST NOT inherit
 * the previous cached mode, because that would let an `ALLOW` policy
 * from one state dir bleed into another state dir that has no policy
 * file of its own. The store contract is: "no valid file => ASK".
 */
static void reset_to_safe_default_doc(void) {
    g_cached_mode = OC_EXEC_QUICK_MODE_ASK;
    replace_full_doc(build_default_doc());
}

static void load_from_disk(void) {
    g_autofree gchar *path = resolve_storage_path();
    g_loaded = TRUE; /* mark loaded even on failure so we don't retry forever */

    /* No path resolved (no state dir, no override) or the file does not
     * exist at this path: fall back to the safe default. The reset is
     * unconditional so a previously-loaded ALLOW from a different state
     * dir does not survive a switch to an unconfigured one. */
    if (!path || !g_file_test(path, G_FILE_TEST_EXISTS)) {
        reset_to_safe_default_doc();
        return;
    }

    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) error = NULL;
    if (!json_parser_load_from_file(parser, path, &error)) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec-approval-store: parse %s failed: %s — falling back to defaults",
                    path, error ? error->message : "?");
        /* Corrupt JSON must reset to ASK, not preserve whatever mode we
         * happened to be holding from a prior load. */
        reset_to_safe_default_doc();
        return;
    }

    JsonNode *root = json_parser_get_root(parser);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec-approval-store: %s does not contain a JSON object",
                    path);
        reset_to_safe_default_doc();
        return;
    }

    /* Take a deep copy of the root so we own the lifetime independently
     * of the parser. */
    replace_full_doc(json_node_copy(root));

    JsonObject *root_obj = json_node_get_object(g_full_doc);
    JsonObject *defaults = oc_json_object_member(root_obj, "defaults");
    const gchar *security = defaults ? oc_json_string_member(defaults, "security") : NULL;
    const gchar *ask = defaults ? oc_json_string_member(defaults, "ask") : NULL;
    g_cached_mode = quick_mode_from_strings(security, ask);
}

static gboolean write_to_disk_atomic(void) {
    g_autofree gchar *path = resolve_storage_path();
    if (!path) return FALSE;
    if (!ensure_parent_dir(path)) return FALSE;

    if (!g_full_doc) replace_full_doc(build_default_doc());

    /* Update defaults.security/.ask in the carry-through doc. */
    JsonObject *root_obj = json_node_get_object(g_full_doc);
    if (!json_object_has_member(root_obj, "version")) {
        json_object_set_int_member(root_obj, "version", EXEC_APPROVAL_STORE_VERSION);
    }
    JsonObject *defaults = oc_json_object_member(root_obj, "defaults");
    if (!defaults) {
        defaults = json_object_new();
        json_object_set_object_member(root_obj, "defaults", defaults);
    }
    const gchar *sec = NULL, *ask = NULL;
    quick_mode_to_strings(g_cached_mode, &sec, &ask);
    json_object_set_string_member(defaults, "security", sec);
    json_object_set_string_member(defaults, "ask", ask);

    g_autoptr(JsonGenerator) gen = json_generator_new();
    json_generator_set_pretty(gen, TRUE);
    json_generator_set_indent(gen, 2);
    json_generator_set_root(gen, g_full_doc);
    g_autofree gchar *data = json_generator_to_data(gen, NULL);
    if (!data) return FALSE;
    gsize data_len = strlen(data);

    g_autofree gchar *tmp = g_strdup_printf("%s.tmp.%u", path, g_random_int());
    int fd = g_open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec-approval-store: open %s failed: %s",
                    tmp, g_strerror(errno));
        return FALSE;
    }
    gsize written = 0;
    while (written < data_len) {
        gssize n = write(fd, data + written, data_len - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            g_close(fd, NULL);
            (void)g_unlink(tmp);
            OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                        "exec-approval-store: write %s failed: %s",
                        tmp, g_strerror(errno));
            return FALSE;
        }
        written += (gsize)n;
    }
    (void)fsync(fd);
    g_close(fd, NULL);
    (void)g_chmod(tmp, 0600);
    if (g_rename(tmp, path) != 0) {
        (void)g_unlink(tmp);
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec-approval-store: rename %s -> %s failed: %s",
                    tmp, path, g_strerror(errno));
        return FALSE;
    }
    (void)g_chmod(path, 0600);
    g_dirty = FALSE;
    return TRUE;
}

void exec_approval_store_init(void) {
    /* Idempotent: subsequent calls are a no-op. The first call leaves
     * the cache in defaults until either set_state_dir or get_quick_mode
     * actually triggers disk I/O. */
}

void exec_approval_store_shutdown(void) {
    g_clear_pointer(&g_state_dir, g_free);
    g_clear_pointer(&g_storage_path_override, g_free);
    if (g_full_doc) {
        json_node_unref(g_full_doc);
        g_full_doc = NULL;
    }
    g_cached_mode = OC_EXEC_QUICK_MODE_ASK;
    g_loaded = FALSE;
    g_dirty = FALSE;
}

void exec_approval_store_set_state_dir(const gchar *state_dir) {
    /* Treat NULL and "" identically: no resolvable path, defer writes. */
    const gchar *normalized = (state_dir && state_dir[0] != '\0') ? state_dir : NULL;

    if (g_strcmp0(g_state_dir, normalized) == 0) {
        /* Same dir — flush any pending mutation if we have one and haven't yet. */
        if (g_dirty && normalized) {
            (void)write_to_disk_atomic();
        }
        return;
    }

    g_clear_pointer(&g_state_dir, g_free);
    g_state_dir = normalized ? g_strdup(normalized) : NULL;

    if (!normalized) {
        /* Cleared dir: keep the in-memory cache so the picker still
         * reflects the operator's choice, but force a re-read on the
         * next non-NULL set so we pick up whatever lives at that path. */
        g_loaded = FALSE;
        return;
    }

    if (g_dirty) {
        /* We had unflushed mutations (e.g. operator toggled the quick
         * mode before the gateway client resolved the state dir). Flush
         * them to the freshly-known path so we don't silently lose the
         * choice. The carry-through doc may not match what's on disk;
         * we deliberately favor the operator's local intent here. */
        (void)write_to_disk_atomic();
        g_loaded = TRUE;
        return;
    }

    /*
     * New dir, no pending dirty state: drop any cached document and
     * cached mode from the previous state dir BEFORE reading. This is
     * the critical step that prevents an ALLOW policy from one state
     * dir leaking into another that has no `exec-approvals.json` file.
     *
     * load_from_disk() then either populates the cache from a real file
     * at the new path, or hits reset_to_safe_default_doc() and lands on
     * ASK with a fresh default document.
     */
    if (g_full_doc) {
        json_node_unref(g_full_doc);
        g_full_doc = NULL;
    }
    g_cached_mode = OC_EXEC_QUICK_MODE_ASK;
    g_loaded = FALSE;
    load_from_disk();
}

OcExecQuickMode exec_approval_store_get_quick_mode(void) {
    if (!g_loaded) load_from_disk();
    return g_cached_mode;
}

gboolean exec_approval_store_set_quick_mode(OcExecQuickMode mode) {
    if (!g_loaded) load_from_disk();
    if (g_cached_mode == mode && !g_dirty) {
        return resolve_storage_path() != NULL;
    }
    g_cached_mode = mode;

    g_autofree gchar *path = resolve_storage_path();
    if (!path) {
        /* No state dir yet — buffer until set_state_dir() is called. */
        g_dirty = TRUE;
        return FALSE;
    }

    if (write_to_disk_atomic()) return TRUE;
    g_dirty = TRUE;
    return FALSE;
}

void exec_approval_store_test_set_storage_path(const gchar *path) {
    g_clear_pointer(&g_storage_path_override, g_free);
    if (path) g_storage_path_override = g_strdup(path);
    g_loaded = FALSE;
    g_dirty = FALSE;
    if (g_full_doc) {
        json_node_unref(g_full_doc);
        g_full_doc = NULL;
    }
}

void exec_approval_store_test_reset(void) {
    g_clear_pointer(&g_state_dir, g_free);
    g_clear_pointer(&g_storage_path_override, g_free);
    if (g_full_doc) {
        json_node_unref(g_full_doc);
        g_full_doc = NULL;
    }
    g_cached_mode = OC_EXEC_QUICK_MODE_ASK;
    g_loaded = FALSE;
    g_dirty = FALSE;
}
