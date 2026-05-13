/*
 * exec_approval_request.h
 *
 * Value type and JSON parser for `exec.approval.requested` gateway events.
 * Mirrors the canonical payload emitted by the gateway server (see
 * `src/gateway/server-methods/exec-approval.ts`):
 *
 *   {
 *     "id":          string,
 *     "request":     { command, cwd?, host?, nodeId?, agentId?, security?,
 *                      ask?, resolvedPath?, sessionKey?, allowedDecisions? },
 *     "createdAtMs": number,
 *     "expiresAtMs": number
 *   }
 *
 * Headless: pure-C / json-glib. No GTK, no Adwaita, no gateway_ws/rpc.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_EXEC_APPROVAL_REQUEST_H
#define OPENCLAW_LINUX_EXEC_APPROVAL_REQUEST_H

#include <glib.h>
#include <json-glib/json-glib.h>

typedef struct {
    gchar  *id;
    gchar  *command;
    gchar  *cwd;
    gchar  *host;
    gchar  *node_id;
    gchar  *agent_id;
    gchar  *resolved_path;
    gchar  *security;
    gchar  *ask;
    gchar  *session_key;
    /* NULL-terminated array of decision strings, or NULL when the gateway
     * did not constrain the allowed set (treat as "all decisions allowed"). */
    gchar **allowed_decisions;
    gint64  created_at_ms;
    gint64  expires_at_ms;
} OcExecApprovalRequest;

/*
 * Parse a `exec.approval.requested` payload into a freshly allocated
 * OcExecApprovalRequest. Returns NULL when:
 *   - payload is NULL or not an object;
 *   - `id` is missing/empty;
 *   - `request.command` is missing/empty;
 *   - `createdAtMs` or `expiresAtMs` is missing/non-positive.
 */
OcExecApprovalRequest* oc_exec_approval_request_new_from_event(JsonNode *payload);

/* Deep copy. Returns NULL when src is NULL. */
OcExecApprovalRequest* oc_exec_approval_request_copy(const OcExecApprovalRequest *src);

/* Free all owned members and the struct itself. NULL-safe. */
void oc_exec_approval_request_free(OcExecApprovalRequest *req);

/*
 * Returns TRUE when `decision` is an allowed terminal decision for this
 * request. When `req->allowed_decisions` is NULL all decisions are
 * permitted (matches the gateway contract: omitted = no constraint).
 */
gboolean oc_exec_approval_request_allows_decision(const OcExecApprovalRequest *req,
                                                  const gchar *decision);

/* Returns TRUE when now_ms is at-or-after expires_at_ms. */
gboolean oc_exec_approval_request_is_expired(const OcExecApprovalRequest *req,
                                             gint64 now_ms);

/* Wall-clock helper expressed in milliseconds since the unix epoch. */
gint64 oc_exec_approval_now_ms(void);

G_DEFINE_AUTOPTR_CLEANUP_FUNC(OcExecApprovalRequest, oc_exec_approval_request_free)

#endif /* OPENCLAW_LINUX_EXEC_APPROVAL_REQUEST_H */
