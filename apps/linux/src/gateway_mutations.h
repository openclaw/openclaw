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
 * Create or update a cron job. Pass the full payload as a pre-built
 * JsonNode (object). Ownership is NOT transferred — caller retains it.
 */
gchar* mutation_cron_add(JsonNode *params,
                         GatewayRpcCallback cb, gpointer data);

gchar* mutation_cron_update(JsonNode *params,
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

#endif /* OPENCLAW_LINUX_GATEWAY_MUTATIONS_H */
