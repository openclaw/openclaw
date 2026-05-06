/*
 * gateway_data.h
 *
 * Gateway data adapter layer for the OpenClaw Linux Companion App.
 *
 * Defines C structs mirroring verified gateway RPC response payloads
 * (channels.status, skills.status, sessions.list, cron.list, node.list,
 * cron.status, cron.runs, node.pair.list, config.get, config.schema)
 * and provides JSON→struct parsing functions. No GTK dependency;
 * testable with plain GLib + json-glib.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_GATEWAY_DATA_H
#define OPENCLAW_LINUX_GATEWAY_DATA_H

#include <glib.h>
#include <json-glib/json-glib.h>

/* ── Channels ────────────────────────────────────────────────────── */

typedef struct {
    gchar *account_id;
    gboolean configured;
    gboolean enabled;
    gboolean running;
    gboolean connected;
    gboolean linked;
    gchar *display_name;
    gchar *mode;
    gchar *dm_policy;
    gdouble last_inbound_at;
    gdouble last_outbound_at;
    gchar *last_error;
} GatewayChannelAccount;

typedef struct {
    gchar *channel_id;
    gchar *label;
    gchar *detail_label;
    gchar *system_image;
    gchar *default_account_id;
    gboolean connected;
    gint account_count;
    GatewayChannelAccount *accounts;
    gint n_accounts;
    JsonObject *raw_status;   /* retained for channel-type-specific detail rendering */
} GatewayChannel;

typedef struct {
    gint64 ts;
    GatewayChannel *channels;
    gint n_channels;
    gchar **channel_order;  /* NULL-terminated */
    gint n_channel_order;
} GatewayChannelsData;

void gateway_channels_data_free(GatewayChannelsData *data);
GatewayChannelsData* gateway_data_parse_channels(JsonNode *payload);

/* ── Skills ──────────────────────────────────────────────────────── */

typedef struct {
    gchar *path;
    gchar *value_str;   /* formatted value for display, or NULL */
    gboolean satisfied;
} GatewaySkillConfigCheck;

typedef struct {
    gchar *id;
    gchar *kind;
    gchar *label;
    gchar **bins;       /* NULL-terminated */
    gint n_bins;
} GatewaySkillInstallOption;

typedef struct {
    gchar *name;
    gchar *description;
    gchar *source;
    gchar *key;
    gchar *primary_env;
    gchar *emoji;
    gchar *homepage;
    gboolean enabled;
    gboolean disabled;
    gboolean installed;
    gboolean managed;
    gboolean bundled;
    gboolean has_update;
    gboolean eligible;
    gboolean always;
    /* requirements */
    gchar **req_bins;       /* NULL-terminated */
    gint n_req_bins;
    gchar **req_env;        /* NULL-terminated */
    gint n_req_env;
    gchar **req_config;     /* NULL-terminated */
    gint n_req_config;
    /* missing */
    gchar **missing_bins;   /* NULL-terminated */
    gint n_missing_bins;
    gchar **missing_env;    /* NULL-terminated */
    gint n_missing_env;
    gchar **missing_config; /* NULL-terminated */
    gint n_missing_config;
    /* config checks */
    GatewaySkillConfigCheck *config_checks;
    gint n_config_checks;
    /* install options */
    GatewaySkillInstallOption *install_options;
    gint n_install_options;
} GatewaySkill;

typedef struct {
    gchar *workspace_dir;
    GatewaySkill *skills;
    gint n_skills;
} GatewaySkillsData;

void gateway_skills_data_free(GatewaySkillsData *data);
GatewaySkillsData* gateway_data_parse_skills(JsonNode *payload);

/* ── Sessions ────────────────────────────────────────────────────── */

typedef struct {
    gchar *model;
    gint context_tokens;
} GatewaySessionDefaults;

typedef struct {
    gchar *key;
    gchar *kind;           /* "direct", "group", "global", "unknown" */
    gchar *display_name;
    gchar *channel;
    gchar *subject;
    gchar *room;
    gchar *space;
    gchar *status;         /* "running", "done", "failed", "killed", "timeout", or NULL */
    gchar *model_provider;
    gchar *model;
    gchar *session_id;
    gchar *thinking_level;
    gchar *verbose_level;
    gint64 updated_at;     /* ms since epoch, or 0 */
    gint input_tokens;
    gint output_tokens;
    gint total_tokens;
    gint context_tokens;
    gboolean system_sent;
    gboolean aborted_last_run;
} GatewaySession;

typedef struct {
    gint64 ts;
    gchar *path;           /* store path */
    gint count;
    GatewaySessionDefaults defaults;
    GatewaySession *sessions;
    gint n_sessions;
} GatewaySessionsData;

void gateway_sessions_data_free(GatewaySessionsData *data);
GatewaySessionsData* gateway_data_parse_sessions(JsonNode *payload);

/* ── Cron ────────────────────────────────────────────────────────── */

typedef struct {
    gchar *id;
    gchar *name;
    gchar *description;
    gboolean enabled;
    gboolean auto_delete;
    gint64 created_at_ms;
    gint64 updated_at_ms;
    /* schedule */
    gchar *schedule_type;     /* "cron", "interval", "at" */
    gchar *schedule_value;    /* cron expression, interval string, or ISO timestamp */
    /* state */
    gint64 next_run_at_ms;    /* from state.nextRunAtMs, 0 if absent */
    gint64 last_run_at_ms;    /* from state.lastRunAtMs, 0 if absent */
    gchar *last_run_status;   /* "ok", "error", "skipped", or NULL */
    gchar *last_error;
    gint64 last_duration_ms;
    /* payload fields */
    gchar *payload_message;   /* agent turn message text */
    gchar *payload_thinking;
    gchar *payload_event;     /* system event text */
    gint payload_timeout;
    gchar *session_target;    /* "main", "isolated" */
    gchar *wake_mode;         /* "now", "next-heartbeat" */
    gchar *delivery;          /* delivery mode string */
    gchar *agent_id;
    gchar *transcript_session_key;
} GatewayCronJob;

typedef struct {
    GatewayCronJob *jobs;
    gint n_jobs;
    gint total;
    gint offset;
    gint limit;
    gboolean has_more;
} GatewayCronData;

typedef struct {
    gboolean enabled;
    gchar *store_path;
    gint64 next_wake_at_ms;
} GatewayCronStatus;

typedef struct {
    gchar *id;
    gchar *job_id;
    gchar *status;        /* "ok", "error", "skipped" */
    gint64 timestamp_ms;
    gint64 duration_ms;
    gchar *summary;
    gchar *error;
} GatewayCronRunEntry;

typedef struct {
    GatewayCronRunEntry *entries;
    gint n_entries;
    gint total;
    gint offset;
    gint limit;
    gboolean has_more;
} GatewayCronRunsData;

void gateway_cron_data_free(GatewayCronData *data);
GatewayCronData* gateway_data_parse_cron(JsonNode *payload);

void gateway_cron_status_free(GatewayCronStatus *data);
GatewayCronStatus* gateway_data_parse_cron_status(JsonNode *payload);

void gateway_cron_runs_data_free(GatewayCronRunsData *data);
GatewayCronRunsData* gateway_data_parse_cron_runs(JsonNode *payload);

/* ── Nodes (Remote Instances) ────────────────────────────────────── */

typedef struct {
    gchar *node_id;
    gchar *display_name;
    gchar *platform;
    gchar *version;
    gchar *core_version;
    gchar *ui_version;
    gchar *device_family;
    gchar *model_identifier;
    gchar *remote_ip;
    gboolean paired;
    gboolean connected;
    gint64 connected_at_ms;
    gint64 approved_at_ms;
} GatewayNode;

typedef struct {
    gint64 ts;
    GatewayNode *nodes;
    gint n_nodes;
} GatewayNodesData;

void gateway_nodes_data_free(GatewayNodesData *data);
GatewayNodesData* gateway_data_parse_nodes(JsonNode *payload);

/* ── Node Pairing ────────────────────────────────────────────────── */

typedef struct {
    gchar *request_id;
    gchar *node_id;
    gchar *display_name;
    gchar *platform;
    gchar *version;
    gchar *remote_ip;
    gboolean is_repair;
    gdouble ts;
} GatewayPendingPairRequest;

typedef struct {
    gchar *node_id;
    gchar *display_name;
    gchar *platform;
    gchar *version;
    gchar *remote_ip;
    gdouble approved_at_ms;
} GatewayPairedNode;

typedef struct {
    GatewayPendingPairRequest *pending;
    gint n_pending;
    GatewayPairedNode *paired;
    gint n_paired;
} GatewayPairingList;

void gateway_pairing_list_free(GatewayPairingList *data);
GatewayPairingList* gateway_data_parse_pairing_list(JsonNode *payload);

/* ── Config ──────────────────────────────────────────────────────── */

typedef struct {
    gchar *path;
    gchar *hash;
    gboolean exists;
    gboolean valid;
    JsonObject *config;   /* retained; caller must not modify */
    gchar **issues;       /* NULL-terminated, or NULL */
    gint n_issues;
} GatewayConfigSnapshot;

void gateway_config_snapshot_free(GatewayConfigSnapshot *data);
GatewayConfigSnapshot* gateway_data_parse_config_get(JsonNode *payload);

typedef struct {
    JsonObject *schema;   /* retained full schema tree */
    JsonObject *ui_hints; /* retained ui hints */
} GatewayConfigSchema;

void gateway_config_schema_free(GatewayConfigSchema *data);
GatewayConfigSchema* gateway_data_parse_config_schema(JsonNode *payload);

#endif /* OPENCLAW_LINUX_GATEWAY_DATA_H */
