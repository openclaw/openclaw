/*
 * gateway_data.h
 *
 * Gateway data adapter layer for the OpenClaw Linux Companion App.
 *
 * Defines C structs mirroring verified gateway RPC response payloads
 * (channels.status, skills.status, sessions.list, cron.list, node.list)
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
    gchar *channel_id;
    gchar *label;
    gchar *detail_label;
    gchar *default_account_id;
    gboolean connected;
    gint account_count;
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
    gchar *name;
    gchar *description;
    gchar *source;
    gchar *key;
    gboolean enabled;
    gboolean disabled;
    gboolean installed;
    gboolean managed;
    gboolean bundled;
    gboolean has_update;
    gboolean eligible;
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
    gchar *key;
    gchar *kind;           /* "direct", "group", "global", "unknown" */
    gchar *display_name;
    gchar *channel;
    gchar *subject;
    gchar *status;         /* "running", "done", "failed", "killed", "timeout", or NULL */
    gchar *model_provider;
    gchar *model;
    gint64 updated_at;     /* ms since epoch, or 0 */
} GatewaySession;

typedef struct {
    gint64 ts;
    gint count;
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
    gint64 created_at_ms;
    gint64 updated_at_ms;
    gint64 next_run_at_ms;    /* from state.nextRunAtMs, 0 if absent */
    gint64 last_run_at_ms;    /* from state.lastRunAtMs, 0 if absent */
    gchar *last_run_status;   /* "ok", "error", "skipped", or NULL */
    gchar *last_error;
} GatewayCronJob;

typedef struct {
    GatewayCronJob *jobs;
    gint n_jobs;
    gint total;
    gint offset;
    gint limit;
    gboolean has_more;
} GatewayCronData;

void gateway_cron_data_free(GatewayCronData *data);
GatewayCronData* gateway_data_parse_cron(JsonNode *payload);

/* ── Nodes (Remote Instances) ────────────────────────────────────── */

typedef struct {
    gchar *node_id;
    gchar *display_name;
    gchar *platform;
    gchar *version;
    gchar *device_family;
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

#endif /* OPENCLAW_LINUX_GATEWAY_DATA_H */
