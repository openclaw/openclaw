/*
 * gateway_mutations.h
 *
 * Mutation RPC helpers for the OpenClaw Linux Companion App.
 *
 * Provides typed wrappers around gateway_rpc_request for all verified
 * mutation RPCs: Skills (enable/disable/install/update/setEnv),
 * Sessions (patch/reset/delete/compact), Cron (create/update/delete/
 * enable/disable/trigger), Channels (logout/probe/config.set),
 * Nodes (pair.approve/pair.reject), and Config (config.set).
 *
 * Each wrapper builds the correct JSON params object and dispatches
 * via gateway_rpc_request. No GTK dependency; testable with plain GLib.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_GATEWAY_MUTATIONS_H
#define OPENCLAW_LINUX_GATEWAY_MUTATIONS_H

#include "gateway_rpc.h"
#include <glib.h>
#include <json-glib/json-glib.h>

/* ── JSON param builder helpers ──────────────────────────────────── */

JsonNode* mutation_params_new_empty(void);
JsonNode* mutation_params_new_object(void);

/* ── Skills mutations ────────────────────────────────────────────── */

gchar* mutation_skills_enable(const gchar *skill_key, gboolean enable,
                              GatewayRpcCallback cb, gpointer data);

gchar* mutation_skills_install(const gchar *name, const gchar *install_id,
                               GatewayRpcCallback cb, gpointer data);

gchar* mutation_skills_update(const gchar *skill_key,
                              GatewayRpcCallback cb, gpointer data);

gchar* mutation_skills_update_env(const gchar *skill_key, const gchar *env_name,
                                  const gchar *value,
                                  GatewayRpcCallback cb, gpointer data);

gchar* mutation_skills_update_api_key(const gchar *skill_key, const gchar *api_key,
                                      GatewayRpcCallback cb, gpointer data);

/* ── Sessions mutations ──────────────────────────────────────────── */

gchar* mutation_sessions_patch(const gchar *session_key,
                               const gchar *thinking_level,
                               const gchar *verbose_level,
                               const gchar *model,
                               GatewayRpcCallback cb, gpointer data);

gchar* mutation_sessions_reset(const gchar *session_key,
                               GatewayRpcCallback cb, gpointer data);

gchar* mutation_sessions_delete(const gchar *session_key,
                                gboolean delete_transcript,
                                GatewayRpcCallback cb, gpointer data);

gchar* mutation_sessions_compact(const gchar *session_key,
                                 GatewayRpcCallback cb, gpointer data);

/* ── Cron mutations ──────────────────────────────────────────────── */

gchar* mutation_cron_enable(const gchar *job_id, gboolean enable,
                            GatewayRpcCallback cb, gpointer data);

gchar* mutation_cron_remove(const gchar *job_id,
                            GatewayRpcCallback cb, gpointer data);

gchar* mutation_cron_run(const gchar *job_id,
                         GatewayRpcCallback cb, gpointer data);

/*
 * Typed input for cron.add / cron.update payloads.
 *
 * Optional-field semantics (preserved from the previous UI builder):
 *   - description omitted when NULL or empty.
 *   - agent_id omitted when NULL or empty.
 *   - prompt omitted (no payload object) when NULL or empty. Callers that
 *     require a prompt (for example the create UI) validate this themselves;
 *     the mutation layer does not enforce it.
 *
 * All const gchar* members are borrowed; the caller retains ownership.
 */
typedef struct {
    const gchar *name;            /* required, non-empty */
    const gchar *description;     /* optional */
    const gchar *agent_id;        /* optional */
    const gchar *schedule_kind;   /* required; "cron" today */
    const gchar *schedule_expr;   /* required */
    const gchar *session_target;  /* required, e.g. "main"/"current"/"isolated" */
    const gchar *wake_mode;       /* required, e.g. "now"/"next-heartbeat" */
    const gchar *prompt;          /* optional; produces payload.message */
} GatewayCronJobMutationFields;

/*
 * Create a cron job. Emits enabled: true at the root in addition to the
 * shared field block built by mutation_build_cron_job_fields.
 */
gchar* mutation_cron_add(const GatewayCronJobMutationFields *fields,
                         GatewayRpcCallback cb, gpointer data);

/*
 * Update a cron job. Emits { id, patch: { ...shared field block... } }.
 * Does not emit enabled (use mutation_cron_enable for that).
 */
gchar* mutation_cron_update(const gchar *id,
                            const GatewayCronJobMutationFields *fields,
                            GatewayRpcCallback cb, gpointer data);

/* ── Channels mutations ──────────────────────────────────────────── */

gchar* mutation_channels_status(gboolean probe,
                                GatewayRpcCallback cb, gpointer data);

gchar* mutation_channels_logout(const gchar *channel, const gchar *account_id,
                                GatewayRpcCallback cb, gpointer data);

/* WhatsApp QR login flow */
gchar* mutation_web_login_start(GatewayRpcCallback cb, gpointer data);
gchar* mutation_web_login_wait(guint timeout_ms, const gchar *account_id,
                               GatewayRpcCallback cb, gpointer data);

/* ── Config mutations ────────────────────────────────────────────── */

gchar* mutation_config_get(const gchar *scope,
                           GatewayRpcCallback cb, gpointer data);

gchar* mutation_config_schema(const gchar *scope,
                              GatewayRpcCallback cb, gpointer data);

/*
 * config.set — pass the full config JSON as raw string and base hash for OCC.
 */
gchar* mutation_config_set(const gchar *raw_json, const gchar *base_hash,
                           GatewayRpcCallback cb, gpointer data);

/* ── Nodes (Instances) mutations ─────────────────────────────────── */

gchar* mutation_node_pair_approve(const gchar *request_id,
                                  GatewayRpcCallback cb, gpointer data);

gchar* mutation_node_pair_reject(const gchar *request_id,
                                 GatewayRpcCallback cb, gpointer data);

gchar* mutation_node_list(GatewayRpcCallback cb, gpointer data);

gchar* mutation_node_pair_list(GatewayRpcCallback cb, gpointer data);

/* ── System mutations ────────────────────────────────────────────── */

/*
 * Set the persistent heartbeats-enabled flag on the gateway. Maps to
 * the macOS `set-heartbeats` RPC (see `src/gateway/server-methods/
 * system.ts`). Params: { "enabled": <bool> }.
 */
gchar* mutation_system_set_heartbeats(gboolean enabled,
                                      GatewayRpcCallback cb, gpointer data);

#endif /* OPENCLAW_LINUX_GATEWAY_MUTATIONS_H */
