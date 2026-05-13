/*
 * exec_approval_store.h
 *
 * Persisted policy store for in-app exec approvals on Linux.
 *
 * Tranche B scope: a single "Quick Mode" default — Deny / Ask / Allow —
 * mapped onto the macOS-compatible `ExecApprovalsFile` shape so that the
 * on-disk file can be read by the macOS companion (and vice-versa) when
 * a state directory is shared:
 *
 *   {
 *     "version":  1,
 *     "defaults": { "security": "deny|allowlist|full",
 *                   "ask":      "off|on-miss|always" }
 *   }
 *
 * The `agents` map is reserved for future per-agent overrides and is
 * preserved on round-trip but never edited by this tranche.
 *
 * Path resolution
 * ───────────────
 * The state-dir for the file is supplied externally by the caller via
 * `exec_approval_store_set_state_dir()`. This is required because:
 *   - the runtime state dir is only known after the gateway client
 *     resolves it (see gateway_client.c::apply_runtime_paths_*),
 *   - and may switch on remote/local mode toggles or profile changes.
 *
 * Until a state-dir is supplied, mutations are kept in an in-memory
 * cache and flushed on the first set_state_dir() call.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_EXEC_APPROVAL_STORE_H
#define OPENCLAW_LINUX_EXEC_APPROVAL_STORE_H

#include <glib.h>

typedef enum {
    OC_EXEC_QUICK_MODE_DENY  = 0,  /* security=deny,      ask=off    */
    OC_EXEC_QUICK_MODE_ASK   = 1,  /* security=allowlist, ask=on-miss */
    OC_EXEC_QUICK_MODE_ALLOW = 2,  /* security=full,      ask=off    */
} OcExecQuickMode;

/* Init / shutdown the in-process singleton. Idempotent. */
void exec_approval_store_init(void);
void exec_approval_store_shutdown(void);

/*
 * Set or clear the runtime state directory used to resolve the storage
 * file path (`<state_dir>/exec-approvals.json`).
 *
 * Pass NULL to clear (e.g. on connection-mode switch when the new dir
 * is not yet known); subsequent reads return the in-memory cache and
 * subsequent mutations are buffered until the next non-NULL call.
 *
 * Calling with the same path is a no-op. Calling with a different path
 * triggers a re-read from the new location, replacing the in-memory
 * cache and any pending unflushed mutations.
 *
 * Safe to call repeatedly; mirrors `gateway_ws_set_identity_context()`
 * and `remote_tunnel_set_state_dir()` so the gateway client can wire
 * all three from a single resolve point.
 */
void exec_approval_store_set_state_dir(const gchar *state_dir);

/* Current in-memory quick-mode default. Lazy-loads from disk on first
 * call after init / set_state_dir. */
OcExecQuickMode exec_approval_store_get_quick_mode(void);

/*
 * Update the quick-mode default. Persists immediately when a state_dir
 * is set; otherwise updates the in-memory cache only and defers the
 * disk write to the next `exec_approval_store_set_state_dir()` call.
 *
 * Returns TRUE on persistent write, FALSE when the value was buffered
 * (no state dir) or when disk I/O failed.
 */
gboolean exec_approval_store_set_quick_mode(OcExecQuickMode mode);

/*
 * Test seam: bypass `set_state_dir()` and pin the storage file path
 * verbatim. Pass NULL to clear and revert to state-dir resolution.
 */
void exec_approval_store_test_set_storage_path(const gchar *path);

/*
 * Test seam: clear all in-memory state and forget any storage path.
 * Equivalent to `exec_approval_store_shutdown()` followed by
 * `exec_approval_store_init()` but does not log.
 */
void exec_approval_store_test_reset(void);

#endif /* OPENCLAW_LINUX_EXEC_APPROVAL_STORE_H */
