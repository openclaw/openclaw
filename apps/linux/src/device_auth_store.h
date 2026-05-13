/*
 * device_auth_store.h
 *
 * Durable device-token store for the OpenClaw Linux Companion App.
 *
 * Persists byte-compatible counterparts of src/shared/device-auth.ts
 * DeviceAuthStore v1 records at <state_dir>/identity/device-auth.json.
 *
 * Schema:
 *   {
 *     "version": 1,
 *     "deviceId": "<hex>",
 *     "tokens": {
 *       "operator": {
 *         "token":      "<opaque>",
 *         "role":       "operator",
 *         "scopes":     ["operator.admin", "operator.read", ...],
 *         "updatedAtMs": 1712345678901
 *       },
 *       ...
 *     }
 *   }
 *
 * Scope normalization mirrors normalizeDeviceAuthScopes() in TS:
 *   - if "operator.admin" is in the set, imply "operator.read" + "operator.write"
 *   - if "operator.write" is in the set, imply "operator.read"
 *   - sorted ascending, deduplicated
 *
 * File is persisted with 0600 perms; parent dir with 0700.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_DEVICE_AUTH_STORE_H
#define OPENCLAW_LINUX_DEVICE_AUTH_STORE_H

#include <glib.h>

typedef struct {
    gchar   *token;           /* opaque device token issued by the gateway */
    gchar   *role;            /* e.g. "operator" */
    gchar  **scopes;          /* NULL-terminated string array */
    gint64   updated_at_ms;
} OcDeviceAuthEntry;

/*
 * Load the token entry for (device_id, role) from the Linux auth store.
 * Returns NULL if not present, on I/O failure, or if the stored deviceId
 * does not match device_id (stale identity). Caller frees with
 * oc_device_auth_entry_free().
 */
OcDeviceAuthEntry* oc_device_auth_store_load(const gchar *state_dir,
                                             const gchar *device_id,
                                             const gchar *role);

/*
 * Persist the token entry for (device_id, role). Applies TS-parity scope
 * normalization before writing. Atomic write + rename with 0600 perms.
 * Returns TRUE on success. scopes may be NULL (empty array).
 */
gboolean oc_device_auth_store_save(const gchar *state_dir,
                                   const gchar *device_id,
                                   const gchar *role,
                                   const gchar *token,
                                   const gchar * const *scopes);

/*
 * Remove the token entry for (device_id, role). If the store's deviceId
 * does not match device_id, or the entry is not present, this is a no-op.
 * Returns TRUE on success (including no-op).
 */
gboolean oc_device_auth_store_clear(const gchar *state_dir,
                                    const gchar *device_id,
                                    const gchar *role);

void oc_device_auth_entry_free(OcDeviceAuthEntry *entry);

G_DEFINE_AUTOPTR_CLEANUP_FUNC(OcDeviceAuthEntry, oc_device_auth_entry_free)

/*
 * Test-only seam: apply the operator-scope implication and sort rules.
 * Returns a newly-allocated NULL-terminated sorted+deduped array.
 */
gchar** oc_device_auth_normalize_scopes(const gchar * const *scopes);

#endif /* OPENCLAW_LINUX_DEVICE_AUTH_STORE_H */
