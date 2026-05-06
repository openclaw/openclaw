/*
 * device_auth_store.c
 *
 * Durable device-token store implementation — DeviceAuthStore v1,
 * byte-compatible with src/shared/device-auth.ts.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "device_auth_store.h"
#include "json_access.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define OC_AUTH_DIR_NAME   "identity"
#define OC_AUTH_FILE_NAME  "device-auth.json"

#define OC_AUTH_ROLE_OPERATOR "operator"

static gchar* resolve_auth_file_path(const gchar *state_dir) {
    if (!state_dir || state_dir[0] == '\0') return NULL;
    return g_build_filename(state_dir, OC_AUTH_DIR_NAME, OC_AUTH_FILE_NAME, NULL);
}

static gboolean ensure_parent_dirs(const gchar *file_path) {
    g_autofree gchar *dir = g_path_get_dirname(file_path);
    if (!dir) return FALSE;
    if (g_mkdir_with_parents(dir, 0700) != 0 && errno != EEXIST) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "device-auth-store: mkdir %s failed: %s", dir, g_strerror(errno));
        return FALSE;
    }
    (void)g_chmod(dir, 0700);
    return TRUE;
}

static gchar* normalize_role(const gchar *role) {
    if (!role) return NULL;
    gchar *trimmed = g_strstrip(g_strdup(role));
    if (trimmed[0] == '\0') {
        g_free(trimmed);
        return NULL;
    }
    return trimmed;
}

static gint gcompare_string_asc(gconstpointer a, gconstpointer b) {
    const gchar * const *aa = a;
    const gchar * const *bb = b;
    return g_strcmp0(*aa, *bb);
}

gchar** oc_device_auth_normalize_scopes(const gchar * const *scopes) {
    g_autoptr(GHashTable) set = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    if (scopes) {
        for (gsize i = 0; scopes[i]; i++) {
            g_autofree gchar *trimmed = g_strstrip(g_strdup(scopes[i]));
            if (trimmed[0] == '\0') continue;
            if (!g_hash_table_contains(set, trimmed)) {
                g_hash_table_add(set, g_strdup(trimmed));
            }
        }
    }

    /* Apply TS-parity implication rules: admin ⇒ read+write; write ⇒ read. */
    if (g_hash_table_contains(set, "operator.admin")) {
        if (!g_hash_table_contains(set, "operator.read")) {
            g_hash_table_add(set, g_strdup("operator.read"));
        }
        if (!g_hash_table_contains(set, "operator.write")) {
            g_hash_table_add(set, g_strdup("operator.write"));
        }
    } else if (g_hash_table_contains(set, "operator.write")) {
        if (!g_hash_table_contains(set, "operator.read")) {
            g_hash_table_add(set, g_strdup("operator.read"));
        }
    }

    guint n = g_hash_table_size(set);
    gchar **arr = g_new0(gchar *, n + 1);
    GHashTableIter iter;
    gpointer key;
    g_hash_table_iter_init(&iter, set);
    guint i = 0;
    while (g_hash_table_iter_next(&iter, &key, NULL)) {
        arr[i++] = g_strdup((const gchar *)key);
    }
    arr[n] = NULL;
    qsort(arr, n, sizeof(gchar *), gcompare_string_asc);
    return arr;
}

static JsonObject* load_store(const gchar *path) {
    if (!g_file_test(path, G_FILE_TEST_EXISTS)) return NULL;
    g_autofree gchar *contents = NULL;
    gsize length = 0;
    if (!g_file_get_contents(path, &contents, &length, NULL)) return NULL;
    g_autoptr(JsonParser) parser = json_parser_new();
    if (!json_parser_load_from_data(parser, contents, (gssize)length, NULL)) return NULL;
    JsonNode *root = json_parser_get_root(parser);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) return NULL;
    /* We cannot return the parser's root after parser goes out of scope, so copy. */
    return json_object_ref(json_node_get_object(root));
}

static gboolean store_version_is_v1(JsonObject *store) {
    if (!store || !json_object_has_member(store, "version")) return FALSE;
    JsonNode *n = json_object_get_member(store, "version");
    if (!JSON_NODE_HOLDS_VALUE(n)) return FALSE;
    return json_node_get_int(n) == 1;
}

static const gchar* store_device_id(JsonObject *store) {
    return oc_json_string_member(store, "deviceId");
}

static JsonObject* store_tokens(JsonObject *store) {
    return oc_json_object_member(store, "tokens");
}

OcDeviceAuthEntry* oc_device_auth_store_load(const gchar *state_dir,
                                             const gchar *device_id,
                                             const gchar *role) {
    if (!device_id || !role) return NULL;
    g_autofree gchar *path = resolve_auth_file_path(state_dir);
    if (!path) return NULL;
    g_autofree gchar *normalized_role = normalize_role(role);
    if (!normalized_role) return NULL;

    g_autoptr(JsonObject) store = load_store(path);
    if (!store) return NULL;
    if (!store_version_is_v1(store)) return NULL;
    const gchar *stored_device = store_device_id(store);
    if (!stored_device || g_strcmp0(stored_device, device_id) != 0) return NULL;
    JsonObject *tokens = store_tokens(store);
    if (!tokens) return NULL;
    JsonObject *role_obj = oc_json_object_member(tokens, normalized_role);
    if (!role_obj) return NULL;

    const gchar *token = oc_json_string_member(role_obj, "token");
    if (!token || token[0] == '\0') return NULL;

    OcDeviceAuthEntry *entry = g_new0(OcDeviceAuthEntry, 1);
    entry->token = g_strdup(token);
    entry->role = g_strdup(oc_json_string_member(role_obj, "role") ?: normalized_role);

    GPtrArray *scopes_arr = g_ptr_array_new();
    JsonArray *scopes_json = oc_json_array_member(role_obj, "scopes");
    if (scopes_json) {
        guint n = json_array_get_length(scopes_json);
        for (guint i = 0; i < n; i++) {
            JsonNode *sn = json_array_get_element(scopes_json, i);
            if (sn && JSON_NODE_HOLDS_VALUE(sn) && json_node_get_value_type(sn) == G_TYPE_STRING) {
                g_ptr_array_add(scopes_arr, g_strdup(json_node_get_string(sn)));
            }
        }
    }
    g_ptr_array_add(scopes_arr, NULL);
    entry->scopes = (gchar **)g_ptr_array_free(scopes_arr, FALSE);

    if (json_object_has_member(role_obj, "updatedAtMs")) {
        JsonNode *n = json_object_get_member(role_obj, "updatedAtMs");
        if (JSON_NODE_HOLDS_VALUE(n)) {
            entry->updated_at_ms = json_node_get_int(n);
        }
    }
    return entry;
}

static gboolean write_store_atomic(const gchar *path, JsonObject *store) {
    g_autoptr(JsonNode) root = json_node_new(JSON_NODE_OBJECT);
    json_node_set_object(root, store);

    g_autoptr(JsonGenerator) gen = json_generator_new();
    json_generator_set_pretty(gen, TRUE);
    json_generator_set_indent(gen, 2);
    json_generator_set_root(gen, root);
    g_autofree gchar *data = json_generator_to_data(gen, NULL);
    if (!data) return FALSE;
    gsize data_len = strlen(data);

    g_autofree gchar *tmp = g_strdup_printf("%s.tmp.%u", path, g_random_int());
    int fd = g_open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "device-auth-store: open %s failed: %s", tmp, g_strerror(errno));
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
                        "device-auth-store: write %s failed: %s", tmp, g_strerror(errno));
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
                    "device-auth-store: rename %s -> %s failed: %s", tmp, path, g_strerror(errno));
        return FALSE;
    }
    (void)g_chmod(path, 0600);
    return TRUE;
}

gboolean oc_device_auth_store_save(const gchar *state_dir,
                                   const gchar *device_id,
                                   const gchar *role,
                                   const gchar *token,
                                   const gchar * const *scopes) {
    if (!device_id || !token || token[0] == '\0') return FALSE;
    g_autofree gchar *path = resolve_auth_file_path(state_dir);
    if (!path) return FALSE;
    g_autofree gchar *normalized_role = normalize_role(role);
    if (!normalized_role) return FALSE;
    if (!ensure_parent_dirs(path)) return FALSE;

    g_autoptr(JsonObject) existing = load_store(path);

    /* If the existing store is for a different device, start fresh. */
    JsonObject *store = json_object_new();
    JsonObject *tokens = NULL;
    if (existing && store_version_is_v1(existing) &&
        g_strcmp0(store_device_id(existing), device_id) == 0) {
        /* Clone tokens from existing into the new store. */
        JsonObject *existing_tokens = store_tokens(existing);
        tokens = json_object_new();
        if (existing_tokens) {
            GList *members = json_object_get_members(existing_tokens);
            for (GList *l = members; l; l = l->next) {
                const gchar *member_name = l->data;
                if (g_strcmp0(member_name, normalized_role) == 0) continue;
                JsonNode *member_node = json_object_get_member(existing_tokens, member_name);
                if (member_node) {
                    json_object_set_member(tokens, member_name, json_node_copy(member_node));
                }
            }
            g_list_free(members);
        }
    } else {
        tokens = json_object_new();
    }

    /* Build the new role entry. */
    g_auto(GStrv) normalized_scopes = oc_device_auth_normalize_scopes(scopes);
    JsonObject *role_obj = json_object_new();
    json_object_set_string_member(role_obj, "token", token);
    json_object_set_string_member(role_obj, "role", normalized_role);
    JsonArray *scope_arr = json_array_new();
    if (normalized_scopes) {
        for (gsize i = 0; normalized_scopes[i]; i++) {
            json_array_add_string_element(scope_arr, normalized_scopes[i]);
        }
    }
    json_object_set_array_member(role_obj, "scopes", scope_arr);
    json_object_set_int_member(role_obj, "updatedAtMs",
                               (gint64)(g_get_real_time() / 1000));
    json_object_set_object_member(tokens, normalized_role, role_obj);

    json_object_set_int_member(store, "version", 1);
    json_object_set_string_member(store, "deviceId", device_id);
    json_object_set_object_member(store, "tokens", tokens);

    gboolean ok = write_store_atomic(path, store);
    json_object_unref(store);
    return ok;
}

gboolean oc_device_auth_store_clear(const gchar *state_dir,
                                    const gchar *device_id,
                                    const gchar *role) {
    if (!device_id || !role) return FALSE;
    g_autofree gchar *path = resolve_auth_file_path(state_dir);
    if (!path) return FALSE;
    g_autofree gchar *normalized_role = normalize_role(role);
    if (!normalized_role) return FALSE;

    g_autoptr(JsonObject) existing = load_store(path);
    if (!existing) return TRUE; /* no-op */
    if (!store_version_is_v1(existing)) return TRUE;
    if (g_strcmp0(store_device_id(existing), device_id) != 0) return TRUE;
    JsonObject *tokens = store_tokens(existing);
    if (!tokens || !json_object_has_member(tokens, normalized_role)) return TRUE;

    /* Rebuild store without the target role. */
    JsonObject *store = json_object_new();
    JsonObject *new_tokens = json_object_new();
    GList *members = json_object_get_members(tokens);
    for (GList *l = members; l; l = l->next) {
        const gchar *member_name = l->data;
        if (g_strcmp0(member_name, normalized_role) == 0) continue;
        JsonNode *member_node = json_object_get_member(tokens, member_name);
        if (member_node) {
            json_object_set_member(new_tokens, member_name, json_node_copy(member_node));
        }
    }
    g_list_free(members);

    json_object_set_int_member(store, "version", 1);
    json_object_set_string_member(store, "deviceId", device_id);
    json_object_set_object_member(store, "tokens", new_tokens);

    gboolean ok = write_store_atomic(path, store);
    json_object_unref(store);
    return ok;
}

void oc_device_auth_entry_free(OcDeviceAuthEntry *entry) {
    if (!entry) return;
    if (entry->token) {
        /* Best-effort clear token before free. */
        volatile gchar *p = entry->token;
        while (*p) *p++ = '\0';
        g_free(entry->token);
    }
    g_free(entry->role);
    g_strfreev(entry->scopes);
    g_free(entry);
}
