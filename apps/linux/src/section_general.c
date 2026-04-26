/*
 * section_general.c
 *
 * General section controller for the OpenClaw Linux Companion App.
 *
 * Owns the main-window general status page, connection mode controls, and
 * service/runtime summary rendering for the local companion workflow.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_general.h"

#include <adwaita.h>

#include "connection_mode_resolver.h"
#include "display_model.h"
#include "exec_approval_store.h"
#include "gateway_client.h"
#include "gateway_config.h"
#include "gateway_remote_config.h"
#include "product_coordinator.h"
#include "product_state.h"
#include "readiness.h"
#include "remote_endpoint.h"
#include "remote_probe.h"
#include "runtime_paths.h"
#include "runtime_reveal.h"
#include "section_adw_helpers.h"
#include "state.h"
#include "ui_model_utils.h"

extern void systemd_start_gateway(void);
extern void systemd_stop_gateway(void);
extern void systemd_restart_gateway(void);

static GtkWidget *gen_status_label = NULL;
static GtkWidget *gen_runtime_label = NULL;
static GtkWidget *gen_service_notice_row = NULL;
static GtkWidget *gen_connection_mode_dropdown = NULL;
static GtkStringList *gen_connection_mode_dropdown_model = NULL;
static GtkWidget *gen_connection_mode_detail_row = NULL;
static gboolean gen_connection_mode_programmatic_change = FALSE;
static GtkWidget *gen_approval_mode_dropdown = NULL;
static GtkStringList *gen_approval_mode_dropdown_model = NULL;
static GtkWidget *gen_approval_mode_detail_row = NULL;
static gboolean gen_approval_mode_programmatic_change = FALSE;
static GtkWidget *gen_endpoint_label = NULL;
static GtkWidget *gen_version_label = NULL;
static GtkWidget *gen_auth_mode_label = NULL;
static GtkWidget *gen_auth_source_label = NULL;
static GtkWidget *gen_unit_label = NULL;
static GtkWidget *gen_active_state_label = NULL;
static GtkWidget *gen_sub_state_label = NULL;
static GtkWidget *gen_config_path_label = NULL;
static GtkWidget *gen_state_dir_label = NULL;
static GtkWidget *gen_profile_label = NULL;
static GtkWidget *gen_btn_start = NULL;
static GtkWidget *gen_btn_stop = NULL;
static GtkWidget *gen_btn_restart = NULL;
static GtkWidget *gen_btn_open_dashboard = NULL;

/* ── Remote-mode settings group ── */
static GtkWidget *gen_remote_group = NULL;
static GtkWidget *gen_remote_transport_dropdown = NULL;
static GtkStringList *gen_remote_transport_model = NULL;
static gboolean gen_remote_transport_programmatic_change = FALSE;
static GtkWidget *gen_remote_url_row = NULL;
static GtkWidget *gen_remote_ssh_target_row = NULL;
static GtkWidget *gen_remote_ssh_identity_row = NULL;
/*
 * Remote auth rows. These map to gateway.remote.token /
 * gateway.remote.password. They are visible regardless of transport
 * because both transports may need the same gateway-side bearer.
 * Empty strings are persisted via the writer's "remove key" semantics.
 */
static GtkWidget *gen_remote_token_row = NULL;
static GtkWidget *gen_remote_password_row = NULL;
static GtkWidget *gen_remote_status_row = NULL;
static GtkWidget *gen_remote_test_btn = NULL;
static GtkWidget *gen_remote_apply_btn = NULL;
static GtkWidget *gen_remote_test_status_label = NULL;
static guint      gen_remote_endpoint_sub = 0;
static GCancellable *gen_remote_probe_cancel = NULL;

static void on_gen_start(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_start_gateway();
}

static void on_gen_stop(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_stop_gateway();
}

static void on_gen_restart(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_restart_gateway();
}

static void on_gen_open_dashboard(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg) {
        return;
    }

    g_autofree gchar *url = gateway_config_dashboard_url(cfg);
    if (url) {
        g_app_info_launch_default_for_uri(url, NULL, NULL);
    }
}

static void on_gen_rerun_onboarding(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    product_coordinator_request_rerun_onboarding();
}

static void on_gen_quit(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    GApplication *app = g_application_get_default();
    if (app) {
        g_application_quit(app);
    }
}

static guint gen_connection_mode_selection_for_mode(ProductConnectionMode mode) {
    return mode == PRODUCT_CONNECTION_MODE_REMOTE ? 1u : 0u;
}

static ProductConnectionMode gen_connection_mode_for_selection(guint selected) {
    return selected == 1u ? PRODUCT_CONNECTION_MODE_REMOTE : PRODUCT_CONNECTION_MODE_LOCAL;
}

static const gchar* gen_connection_mode_detail_text(ProductConnectionMode stored_mode,
                                                    ProductConnectionMode effective_mode) {
    if (effective_mode == PRODUCT_CONNECTION_MODE_REMOTE) {
        return "Remote mode is active. Configure the gateway target below and apply.";
    }

    if (stored_mode == PRODUCT_CONNECTION_MODE_UNSPECIFIED) {
        return "Local is currently the effective default on Linux. Choose a mode here to save it explicitly.";
    }

    return "Use this Linux machine's local gateway and onboarding flow.";
}

static void refresh_general_connection_mode_controls(void) {
    ProductConnectionMode stored_mode = product_state_get_connection_mode();
    ProductConnectionMode effective_mode = product_state_get_effective_connection_mode();
    guint selected = gen_connection_mode_selection_for_mode(effective_mode);

    if (gen_connection_mode_dropdown && ADW_IS_COMBO_ROW(gen_connection_mode_dropdown)) {
        gen_connection_mode_programmatic_change = TRUE;
        adw_combo_row_set_selected(ADW_COMBO_ROW(gen_connection_mode_dropdown), selected);
        gen_connection_mode_programmatic_change = FALSE;
    }

    if (gen_connection_mode_detail_row && ADW_IS_ACTION_ROW(gen_connection_mode_detail_row)) {
        adw_action_row_set_subtitle(ADW_ACTION_ROW(gen_connection_mode_detail_row),
                                    gen_connection_mode_detail_text(stored_mode, effective_mode));
    }
}

static void on_gen_connection_mode_selected_notify(GObject *object,
                                                   GParamSpec *pspec,
                                                   gpointer user_data) {
    (void)pspec;
    (void)user_data;

    if (gen_connection_mode_programmatic_change || !ADW_IS_COMBO_ROW(object)) {
        return;
    }

    guint selected = adw_combo_row_get_selected(ADW_COMBO_ROW(object));
    if (selected == GTK_INVALID_LIST_POSITION) {
        refresh_general_connection_mode_controls();
        return;
    }

    if (!product_coordinator_request_set_connection_mode(gen_connection_mode_for_selection(selected))) {
        refresh_general_connection_mode_controls();
    }
}

/* ── Exec approval quick-mode picker ── */

static guint gen_approval_mode_selection_for_mode(OcExecQuickMode mode) {
    switch (mode) {
    case OC_EXEC_QUICK_MODE_DENY:  return 0u;
    case OC_EXEC_QUICK_MODE_ALLOW: return 2u;
    case OC_EXEC_QUICK_MODE_ASK:
    default:                       return 1u;
    }
}

static OcExecQuickMode gen_approval_mode_for_selection(guint selected) {
    switch (selected) {
    case 0u:  return OC_EXEC_QUICK_MODE_DENY;
    case 2u:  return OC_EXEC_QUICK_MODE_ALLOW;
    case 1u:
    default:  return OC_EXEC_QUICK_MODE_ASK;
    }
}

static const gchar* gen_approval_mode_detail_text(OcExecQuickMode mode) {
    switch (mode) {
    case OC_EXEC_QUICK_MODE_DENY:
        return "Automatically deny every command without prompting.";
    case OC_EXEC_QUICK_MODE_ALLOW:
        return "Automatically allow every command without prompting. Use with care.";
    case OC_EXEC_QUICK_MODE_ASK:
    default:
        return "Show a prompt for each command and decide per request.";
    }
}

static void refresh_general_approval_mode_controls(void) {
    OcExecQuickMode mode = exec_approval_store_get_quick_mode();
    guint selected = gen_approval_mode_selection_for_mode(mode);

    if (gen_approval_mode_dropdown && ADW_IS_COMBO_ROW(gen_approval_mode_dropdown)) {
        gen_approval_mode_programmatic_change = TRUE;
        adw_combo_row_set_selected(ADW_COMBO_ROW(gen_approval_mode_dropdown), selected);
        gen_approval_mode_programmatic_change = FALSE;
    }

    if (gen_approval_mode_detail_row && ADW_IS_ACTION_ROW(gen_approval_mode_detail_row)) {
        adw_action_row_set_subtitle(ADW_ACTION_ROW(gen_approval_mode_detail_row),
                                    gen_approval_mode_detail_text(mode));
    }
}

static void on_gen_approval_mode_selected_notify(GObject *object,
                                                 GParamSpec *pspec,
                                                 gpointer user_data) {
    (void)pspec;
    (void)user_data;

    if (gen_approval_mode_programmatic_change || !ADW_IS_COMBO_ROW(object)) {
        return;
    }

    guint selected = adw_combo_row_get_selected(ADW_COMBO_ROW(object));
    if (selected == GTK_INVALID_LIST_POSITION) {
        refresh_general_approval_mode_controls();
        return;
    }

    OcExecQuickMode mode = gen_approval_mode_for_selection(selected);
    /*
     * `set_quick_mode` returns FALSE when the value was buffered (no
     * state dir resolved yet) or when disk I/O failed. Both are
     * non-fatal: the in-memory cache is updated either way and the
     * gateway-client refresh will flush buffered values to disk.
     */
    (void)exec_approval_store_set_quick_mode(mode);
    refresh_general_approval_mode_controls();
}

static void general_resolve_effective_paths(RuntimeEffectivePaths *out) {
    if (!out) {
        return;
    }

    g_autofree gchar *profile = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *config_path = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    GatewayConfig *cfg = gateway_client_get_config();
    runtime_effective_paths_resolve(cfg, profile, state_dir, config_path, out);
}

static void on_gen_reveal_config(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    g_autofree gchar *uri = runtime_reveal_build_config_dir_uri();
    if (uri) {
        g_app_info_launch_default_for_uri(uri, NULL, NULL);
    }
}

static void on_gen_reveal_state_dir(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    g_autofree gchar *uri = runtime_reveal_build_state_dir_uri();
    if (uri) {
        g_app_info_launch_default_for_uri(uri, NULL, NULL);
    }
}

static GtkWidget* general_action_row(const char *title,
                                     const char *subtitle,
                                     GtkWidget *suffix) {
    GtkWidget *row = adw_action_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(row), title);
    if (subtitle && subtitle[0] != '\0') {
        adw_action_row_set_subtitle(ADW_ACTION_ROW(row), subtitle);
    }
    if (suffix) {
        adw_action_row_add_suffix(ADW_ACTION_ROW(row), suffix);
    }
    return row;
}

static GtkWidget* general_note_row(const char *title) {
    GtkWidget *row = adw_action_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(row), title);
    return row;
}

/* ── Remote-mode form helpers ── */

static GtkWidget* gen_remote_entry_row(const char *title) {
    GtkWidget *row = adw_entry_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(row), title);
    return row;
}

static const gchar* gen_remote_entry_text(GtkWidget *row) {
    if (!row || !ADW_IS_ENTRY_ROW(row)) return "";
    const gchar *t = gtk_editable_get_text(GTK_EDITABLE(row));
    return t ? t : "";
}

static void gen_remote_entry_set(GtkWidget *row, const gchar *text) {
    if (!row || !ADW_IS_ENTRY_ROW(row)) return;
    gtk_editable_set_text(GTK_EDITABLE(row), text ? text : "");
}

static const gchar* gen_remote_selected_transport(void) {
    if (!gen_remote_transport_dropdown ||
        !ADW_IS_COMBO_ROW(gen_remote_transport_dropdown)) {
        return "direct";
    }
    guint sel = adw_combo_row_get_selected(ADW_COMBO_ROW(gen_remote_transport_dropdown));
    return sel == 1u ? "ssh" : "direct";
}

static void gen_remote_set_transport_selection(const gchar *transport) {
    if (!gen_remote_transport_dropdown ||
        !ADW_IS_COMBO_ROW(gen_remote_transport_dropdown)) return;
    guint sel = (g_strcmp0(transport, "ssh") == 0) ? 1u : 0u;
    gen_remote_transport_programmatic_change = TRUE;
    adw_combo_row_set_selected(ADW_COMBO_ROW(gen_remote_transport_dropdown), sel);
    gen_remote_transport_programmatic_change = FALSE;
}

static void gen_remote_refresh_field_visibility(void) {
    const gchar *t = gen_remote_selected_transport();
    gboolean ssh = (g_strcmp0(t, "ssh") == 0);
    if (gen_remote_url_row) gtk_widget_set_visible(gen_remote_url_row, !ssh);
    if (gen_remote_ssh_target_row) gtk_widget_set_visible(gen_remote_ssh_target_row, ssh);
    if (gen_remote_ssh_identity_row) gtk_widget_set_visible(gen_remote_ssh_identity_row, ssh);
}

static void gen_remote_refresh_group_visibility(void) {
    if (!gen_remote_group) return;
    /*
     * Compute visibility from the full resolver context rather than
     * persisted product state alone. A config-declared remote mode
     * (gateway.mode = "remote") or a present gateway.remote subtree
     * must surface the Remote Settings group even when product state
     * still says local — otherwise config-driven deployments would
     * have no UI surface to edit the remote fields.
     */
    GatewayConfig *config = gateway_client_get_config();
    const gchar *cfg_mode = config ? config->mode : NULL;
    gboolean has_remote_url = config && config->remote_url != NULL;
    ProductConnectionMode persisted = product_state_get_connection_mode();
    gboolean onboarded = product_state_get_onboarding_seen_version() > 0;

    EffectiveConnectionMode em = connection_mode_resolve(
        cfg_mode, has_remote_url, persisted, onboarded);
    gtk_widget_set_visible(gen_remote_group,
                           em.mode == PRODUCT_CONNECTION_MODE_REMOTE);
}

static void gen_remote_refresh_status_row(void) {
    if (!gen_remote_status_row || !ADW_IS_ACTION_ROW(gen_remote_status_row)) return;
    const RemoteEndpointSnapshot *ep = remote_endpoint_get();
    if (!ep || ep->kind == REMOTE_ENDPOINT_IDLE) {
        adw_action_row_set_subtitle(ADW_ACTION_ROW(gen_remote_status_row),
                                    "idle (remote mode is not active)");
        return;
    }
    if (ep->kind == REMOTE_ENDPOINT_READY) {
        g_autofree gchar *line = g_strdup_printf("ready — %s://%s:%d",
                                                 ep->tls ? "wss" : "ws",
                                                 ep->host ? ep->host : "?",
                                                 ep->port);
        adw_action_row_set_subtitle(ADW_ACTION_ROW(gen_remote_status_row), line);
        return;
    }
    g_autofree gchar *line = g_strdup_printf("%s%s%s",
                                             remote_endpoint_state_to_string(ep->kind),
                                             ep->detail ? " — " : "",
                                             ep->detail ? ep->detail : "");
    adw_action_row_set_subtitle(ADW_ACTION_ROW(gen_remote_status_row), line);
}

static void on_gen_remote_endpoint_changed(gpointer user_data) {
    (void)user_data;
    gen_remote_refresh_status_row();
}

static void on_gen_remote_transport_notify(GObject *object,
                                           GParamSpec *pspec,
                                           gpointer user_data) {
    (void)pspec;
    (void)user_data;
    if (gen_remote_transport_programmatic_change) return;
    if (!ADW_IS_COMBO_ROW(object)) return;
    gen_remote_refresh_field_visibility();
}

static void gen_remote_seed_from_config(void) {
    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg) {
        gen_remote_set_transport_selection("direct");
        gen_remote_entry_set(gen_remote_url_row, "");
        gen_remote_entry_set(gen_remote_ssh_target_row, "");
        gen_remote_entry_set(gen_remote_ssh_identity_row, "");
        gen_remote_entry_set(gen_remote_token_row, "");
        gen_remote_entry_set(gen_remote_password_row, "");
        gen_remote_refresh_field_visibility();
        return;
    }
    const gchar *transport = "direct";
    if (cfg->remote_transport == REMOTE_TRANSPORT_SSH) transport = "ssh";
    gen_remote_set_transport_selection(transport);

    /*
     * Seed from cfg->remote_url, which is the normalized ws:// or
     * wss:// URL produced by gateway_remote_config_parse at config-load
     * time. Do NOT reconstruct an http/https string from host/port/tls
     * — those legacy fields are derived for the generic gateway client
     * and do not represent the declared gateway.remote.url.
     */
    gen_remote_entry_set(gen_remote_url_row,
                         (cfg->remote_url && cfg->remote_url[0] != '\0')
                             ? cfg->remote_url : "");
    gen_remote_entry_set(gen_remote_ssh_target_row,
                         cfg->remote_ssh_target ? cfg->remote_ssh_target : "");
    /*
     * Token / password rows mirror gateway.remote.token /
     * gateway.remote.password, NOT the in-place overlay on cfg->token.
     * Surfacing the raw remote subtree lets the operator see what is
     * actually persisted in the config file rather than the merged
     * effective value.
     */
    gen_remote_entry_set(gen_remote_token_row,
                         cfg->remote_token ? cfg->remote_token : "");
    gen_remote_entry_set(gen_remote_password_row,
                         cfg->remote_password ? cfg->remote_password : "");
    gen_remote_entry_set(gen_remote_ssh_identity_row,
                         cfg->remote_ssh_identity ? cfg->remote_ssh_identity : "");
    gen_remote_refresh_field_visibility();
}

static void gen_remote_set_test_status(const gchar *text) {
    if (!gen_remote_test_status_label || !GTK_IS_LABEL(gen_remote_test_status_label)) return;
    gtk_label_set_text(GTK_LABEL(gen_remote_test_status_label), text ? text : "");
}

/*
 * Validate + normalize a user-entered URL using the Remote Connection
 * Mode contract (gateway_remote_config_normalize_url). Returns a newly
 * allocated normalized ws:// or wss:// URL on success. On failure,
 * returns NULL and sets *out_error to a short diagnostic string. http
 * and https are intentionally rejected here — the gateway.remote.url
 * contract is ws-only to mirror the macOS companion and the gateway
 * websocket transport.
 */
static gchar* gen_remote_validate_and_normalize_url(const gchar *url,
                                                    gchar **out_host,
                                                    gint *out_port,
                                                    gboolean *out_tls,
                                                    gchar **out_error) {
    if (out_host) *out_host = NULL;
    if (out_port) *out_port = 0;
    if (out_tls) *out_tls = FALSE;
    if (out_error) *out_error = NULL;

    if (!url || url[0] == '\0') {
        if (out_error) *out_error = g_strdup("Gateway URL is empty");
        return NULL;
    }
    g_autofree gchar *trimmed = g_strstrip(g_strdup(url));
    if (trimmed[0] == '\0') {
        if (out_error) *out_error = g_strdup("Gateway URL is empty");
        return NULL;
    }

    gchar *normalized = gateway_remote_config_normalize_url(url,
                                                            out_host,
                                                            out_port,
                                                            out_tls);
    if (!normalized) {
        /* normalize_url rejects http/https and any other non-ws scheme,
         * empty hosts, and non-loopback ws hosts. Report a single
         * user-actionable message rather than leaking parser details. */
        if (out_error) {
            *out_error = g_strdup(
                "URL must be wss://host[:port] or ws://loopback[:port]");
        }
        return NULL;
    }
    return normalized;
}

static void gen_remote_probe_done(const RemoteProbeResult *result, gpointer user_data) {
    (void)user_data;
    g_clear_object(&gen_remote_probe_cancel);
    /*
     * NULL-guard: the General section can be torn down (general_destroy)
     * while a probe is still in flight. The cancellable above will fire,
     * but the callback may still be invoked once during the GMainContext
     * drain — and by then gen_remote_test_btn has been reset to NULL.
     * Mirror the onboarding callback's defensive check.
     */
    if (gen_remote_test_btn) {
        gtk_widget_set_sensitive(gen_remote_test_btn, TRUE);
    }
    if (!result) {
        gen_remote_set_test_status("probe completed without a result");
        return;
    }
    g_autofree gchar *line = NULL;
    if (result->kind == REMOTE_PROBE_OK) {
        line = g_strdup_printf("✅ %s%s%s",
                               result->title ? result->title : "ok",
                               result->detail ? " — " : "",
                               result->detail ? result->detail : "");
    } else {
        line = g_strdup_printf("⚠️ %s%s%s",
                               result->title ? result->title : "failed",
                               result->detail ? " — " : "",
                               result->detail ? result->detail : "");
    }
    gen_remote_set_test_status(line);
}

static void on_gen_remote_test_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    /* Cancel any in-flight probe. */
    if (gen_remote_probe_cancel) {
        g_cancellable_cancel(gen_remote_probe_cancel);
        g_clear_object(&gen_remote_probe_cancel);
    }
    gen_remote_probe_cancel = g_cancellable_new();

    const gchar *transport = gen_remote_selected_transport();
    gtk_widget_set_sensitive(gen_remote_test_btn, FALSE);
    gen_remote_set_test_status("Testing…");

    if (g_strcmp0(transport, "ssh") == 0) {
        const gchar *target = gen_remote_entry_text(gen_remote_ssh_target_row);
        const gchar *identity = gen_remote_entry_text(gen_remote_ssh_identity_row);
        gchar *user = NULL;
        gchar *host = NULL;
        gint port = 22;
        if (!gateway_remote_config_parse_ssh_target(target, &user, &host, &port)) {
            gtk_widget_set_sensitive(gen_remote_test_btn, TRUE);
            gen_remote_set_test_status("⚠️ invalid SSH target — expected user@host[:port]");
            g_clear_object(&gen_remote_probe_cancel);
            return;
        }
        /*
         * Test the same gateway port the coordinator will forward to
         * once SSH mode is applied. Falling back to GATEWAY_DEFAULT_PORT
         * only when no config has loaded keeps the UI testable in
         * pre-onboarding states.
         */
        GatewayConfig *cfg = gateway_client_get_config();
        gint gateway_port = (cfg && cfg->port > 0) ? cfg->port
                                                   : GATEWAY_DEFAULT_PORT;
        remote_probe_ssh_async(user, host, port,
                               (identity && identity[0] != '\0') ? identity : NULL,
                               gateway_port,
                               gen_remote_probe_cancel,
                               gen_remote_probe_done, NULL);
        g_free(user);
        g_free(host);
        return;
    }

    /* direct */
    const gchar *url = gen_remote_entry_text(gen_remote_url_row);
    g_autofree gchar *host = NULL;
    gint port = 0;
    gboolean tls = FALSE;
    g_autofree gchar *err = NULL;
    g_autofree gchar *normalized = gen_remote_validate_and_normalize_url(
        url, &host, &port, &tls, &err);
    if (!normalized) {
        gtk_widget_set_sensitive(gen_remote_test_btn, TRUE);
        g_autofree gchar *line = g_strdup_printf("⚠️ %s", err ? err : "invalid URL");
        gen_remote_set_test_status(line);
        g_clear_object(&gen_remote_probe_cancel);
        return;
    }
    /* Probe the normalized URL so the operator sees a single canonical
     * string across validate → probe → persist. */
    remote_probe_direct_async(normalized,
                              gen_remote_probe_cancel,
                              gen_remote_probe_done, NULL);
}

static gchar* gen_remote_resolve_config_path(void) {
    g_autofree gchar *profile = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *config_path = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    GatewayConfig *cfg = gateway_client_get_config();
    RuntimeEffectivePaths paths = {0};
    runtime_effective_paths_resolve(cfg, profile, state_dir, config_path, &paths);
    gchar *out = paths.effective_config_path
                 ? g_strdup(paths.effective_config_path) : NULL;
    runtime_effective_paths_clear(&paths);
    return out;
}

static void on_gen_remote_apply_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    const gchar *transport = gen_remote_selected_transport();
    const gchar *url = gen_remote_entry_text(gen_remote_url_row);
    const gchar *ssh_target = gen_remote_entry_text(gen_remote_ssh_target_row);
    const gchar *ssh_identity = gen_remote_entry_text(gen_remote_ssh_identity_row);
    const gchar *remote_token = gen_remote_entry_text(gen_remote_token_row);
    const gchar *remote_password = gen_remote_entry_text(gen_remote_password_row);

    /*
     * Pre-validate before touching disk and, for the direct transport,
     * normalize the URL so we persist the canonical ws/wss form that
     * gateway_remote_config_parse will accept on reload.
     */
    g_autofree gchar *normalized_url = NULL;
    if (g_strcmp0(transport, "ssh") == 0) {
        gchar *u = NULL, *h = NULL;
        gint p = 22;
        if (!gateway_remote_config_parse_ssh_target(ssh_target, &u, &h, &p)) {
            gen_remote_set_test_status(
                "⚠️ invalid SSH target — expected user@host[:port]");
            g_free(u); g_free(h);
            return;
        }
        g_free(u); g_free(h);
    } else {
        g_autofree gchar *host = NULL;
        gint port = 0; gboolean tls = FALSE;
        g_autofree gchar *err = NULL;
        normalized_url = gen_remote_validate_and_normalize_url(
            url, &host, &port, &tls, &err);
        if (!normalized_url) {
            g_autofree gchar *line = g_strdup_printf("⚠️ %s",
                                                     err ? err : "invalid URL");
            gen_remote_set_test_status(line);
            return;
        }
    }

    g_autofree gchar *config_path = gen_remote_resolve_config_path();
    if (!config_path || config_path[0] == '\0') {
        gen_remote_set_test_status("⚠️ could not resolve config path");
        return;
    }

    g_autofree gchar *write_err = NULL;
    /*
     * For direct transport, persist the normalized URL so the file
     * always contains a ws/wss form even when the operator typed a
     * shorthand (e.g. "wss://gw"). For ssh transport, pass an empty
     * string so the writer REMOVES gateway.remote.url — the URL row is
     * hidden in SSH mode but may still contain stale/invalid text from
     * a previous direct edit, and gateway_remote_config_parse rejects
     * any present-but-invalid gateway.remote.url on reload.
     */
    const gchar *url_to_persist =
        (g_strcmp0(transport, "ssh") == 0)
            ? ""
            : (normalized_url ? normalized_url : "");
    if (!gateway_config_write_remote_settings(config_path,
                                              "remote",
                                              transport,
                                              url_to_persist,
                                              ssh_target,
                                              ssh_identity,
                                              remote_token,
                                              remote_password,
                                              &write_err)) {
        g_autofree gchar *line = g_strdup_printf("⚠️ save failed — %s",
                                                 write_err ? write_err : "?");
        gen_remote_set_test_status(line);
        return;
    }

    /* Persist the connection-mode intent and trigger the gateway client
     * to re-resolve transport. The product coordinator already handles
     * the gateway_client_refresh() side-effect. */
    if (!product_coordinator_request_set_connection_mode(PRODUCT_CONNECTION_MODE_REMOTE)) {
        gen_remote_set_test_status("⚠️ failed to set connection mode to remote");
        return;
    }
    /* Force a config reload so the new gateway.remote.* fields take effect. */
    gateway_client_refresh();
    gen_remote_set_test_status("✅ Remote settings saved and applied");
}

static GtkWidget* general_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = adw_preferences_page_new();
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *status_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(status_group), "Status");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(status_group));

    GtkWidget *status_row = section_adw_info_row("Status", &gen_status_label);
    gtk_widget_add_css_class(gen_status_label, "title-3");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(status_group), status_row);

    GtkWidget *runtime_row = section_adw_info_row("Runtime", &gen_runtime_label);
    gtk_widget_add_css_class(gen_runtime_label, "dim-label");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(status_group), runtime_row);

    gen_service_notice_row = general_note_row("Service Notice");
    gtk_widget_set_visible(gen_service_notice_row, FALSE);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(status_group), gen_service_notice_row);

    GtkWidget *connection_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(connection_group), "Connection");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(connection_group));

    gen_connection_mode_dropdown = adw_combo_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(gen_connection_mode_dropdown), "Connection Mode");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(connection_group), gen_connection_mode_dropdown);

    GtkStringList *connection_mode_model = gtk_string_list_new(NULL);
    gtk_string_list_append(connection_mode_model, "Local (this machine)");
    gtk_string_list_append(connection_mode_model, "Remote (over SSH or direct)");
    ui_combo_row_replace_model(gen_connection_mode_dropdown,
                               (gpointer *)&gen_connection_mode_dropdown_model,
                               G_LIST_MODEL(connection_mode_model),
                               0);
    g_signal_connect(gen_connection_mode_dropdown,
                     "notify::selected",
                     G_CALLBACK(on_gen_connection_mode_selected_notify),
                     NULL);

    gen_connection_mode_detail_row = general_note_row("Availability");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(connection_group), gen_connection_mode_detail_row);
    refresh_general_connection_mode_controls();

    /* ── Exec approvals quick-mode picker ── */
    GtkWidget *approvals_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(approvals_group), "Approvals");
    adw_preferences_group_set_description(ADW_PREFERENCES_GROUP(approvals_group),
        "Default policy applied to inbound exec approval requests.");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(approvals_group));

    gen_approval_mode_dropdown = adw_combo_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(gen_approval_mode_dropdown),
                                  "Approval Mode");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(approvals_group), gen_approval_mode_dropdown);

    GtkStringList *approval_mode_model = gtk_string_list_new(NULL);
    /* Order matches gen_approval_mode_for_selection: 0 deny, 1 ask, 2 allow. */
    gtk_string_list_append(approval_mode_model, "Deny (auto-deny)");
    gtk_string_list_append(approval_mode_model, "Ask (prompt for each command)");
    gtk_string_list_append(approval_mode_model, "Allow (auto-allow)");
    ui_combo_row_replace_model(gen_approval_mode_dropdown,
                               (gpointer *)&gen_approval_mode_dropdown_model,
                               G_LIST_MODEL(approval_mode_model),
                               0);
    g_signal_connect(gen_approval_mode_dropdown,
                     "notify::selected",
                     G_CALLBACK(on_gen_approval_mode_selected_notify),
                     NULL);

    gen_approval_mode_detail_row = general_note_row("Behavior");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(approvals_group), gen_approval_mode_detail_row);
    refresh_general_approval_mode_controls();

    /* ── Remote settings group (visible only in remote mode) ── */
    gen_remote_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(gen_remote_group), "Remote Settings");
    adw_preferences_group_set_description(ADW_PREFERENCES_GROUP(gen_remote_group),
        "Configure how this companion reaches the gateway when connection mode is Remote.");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(gen_remote_group));

    gen_remote_transport_dropdown = adw_combo_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(gen_remote_transport_dropdown), "Transport");
    GtkStringList *transport_model = gtk_string_list_new(NULL);
    gtk_string_list_append(transport_model, "Direct (gateway reachable on the network)");
    gtk_string_list_append(transport_model, "SSH (forward through a remote host)");
    ui_combo_row_replace_model(gen_remote_transport_dropdown,
                               (gpointer *)&gen_remote_transport_model,
                               G_LIST_MODEL(transport_model),
                               0);
    g_signal_connect(gen_remote_transport_dropdown, "notify::selected",
                     G_CALLBACK(on_gen_remote_transport_notify), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gen_remote_group),
                              gen_remote_transport_dropdown);

    gen_remote_url_row = gen_remote_entry_row("Gateway URL");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gen_remote_group), gen_remote_url_row);

    gen_remote_ssh_target_row = gen_remote_entry_row("SSH Target (user@host[:port])");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gen_remote_group), gen_remote_ssh_target_row);

    gen_remote_ssh_identity_row = gen_remote_entry_row("SSH Identity (private key path, optional)");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gen_remote_group),
                              gen_remote_ssh_identity_row);

    /*
     * Gateway auth rows (gateway.remote.token / gateway.remote.password).
     * Always visible — both transports may need a bearer or password
     * depending on the gateway-side auth configuration. AdwEntryRow
     * is used for the token (operators frequently need to verify a
     * pasted JWT visually) and AdwPasswordEntryRow for the password
     * so it is masked by default.
     */
    gen_remote_token_row = gen_remote_entry_row("Gateway Token (optional)");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gen_remote_group),
                              gen_remote_token_row);

    gen_remote_password_row = adw_password_entry_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(gen_remote_password_row),
                                  "Gateway Password (optional)");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gen_remote_group),
                              gen_remote_password_row);

    gen_remote_status_row = general_note_row("Endpoint Status");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gen_remote_group), gen_remote_status_row);

    /* Action row hosting Test + Apply buttons + a small status label. */
    GtkWidget *remote_actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gen_remote_test_btn = gtk_button_new_with_label("Test Connection");
    g_signal_connect(gen_remote_test_btn, "clicked",
                     G_CALLBACK(on_gen_remote_test_clicked), NULL);
    gtk_box_append(GTK_BOX(remote_actions), gen_remote_test_btn);

    gen_remote_apply_btn = gtk_button_new_with_label("Save & Apply");
    gtk_widget_add_css_class(gen_remote_apply_btn, "suggested-action");
    g_signal_connect(gen_remote_apply_btn, "clicked",
                     G_CALLBACK(on_gen_remote_apply_clicked), NULL);
    gtk_box_append(GTK_BOX(remote_actions), gen_remote_apply_btn);

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gen_remote_group),
                              general_action_row("Apply",
                                                 "Test the configured endpoint, then save and apply.",
                                                 remote_actions));

    gen_remote_test_status_label = gtk_label_new("");
    gtk_label_set_xalign(GTK_LABEL(gen_remote_test_status_label), 0.0f);
    gtk_label_set_wrap(GTK_LABEL(gen_remote_test_status_label), TRUE);
    gtk_widget_add_css_class(gen_remote_test_status_label, "dim-label");
    GtkWidget *status_holder = adw_action_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(status_holder), "Last Action");
    adw_action_row_add_suffix(ADW_ACTION_ROW(status_holder), gen_remote_test_status_label);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gen_remote_group), status_holder);

    /* Live endpoint updates. */
    if (!gen_remote_endpoint_sub) {
        gen_remote_endpoint_sub = remote_endpoint_subscribe(on_gen_remote_endpoint_changed, NULL);
    }
    gen_remote_seed_from_config();
    gen_remote_refresh_status_row();
    gen_remote_refresh_group_visibility();

    GtkWidget *gateway_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(gateway_group), "Gateway");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(gateway_group));

    gen_btn_open_dashboard = gtk_button_new_with_label("Open Dashboard");
    gtk_widget_add_css_class(gen_btn_open_dashboard, "suggested-action");
    g_signal_connect(gen_btn_open_dashboard, "clicked", G_CALLBACK(on_gen_open_dashboard), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gateway_group), section_adw_info_row("Endpoint", &gen_endpoint_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gateway_group), section_adw_info_row("Version", &gen_version_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gateway_group), section_adw_info_row("Auth Mode", &gen_auth_mode_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gateway_group), section_adw_info_row("Auth Source", &gen_auth_source_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gateway_group),
                              general_action_row("Open Dashboard",
                                                 "Open the local gateway dashboard in your browser.",
                                                 gen_btn_open_dashboard));

    GtkWidget *service_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(service_group), "Expected Service");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(service_group));

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(service_group), section_adw_info_row("Unit", &gen_unit_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(service_group), section_adw_info_row("Active State", &gen_active_state_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(service_group), section_adw_info_row("Sub State", &gen_sub_state_label));

    GtkWidget *svc_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);

    gen_btn_start = gtk_button_new_with_label("Start");
    g_signal_connect(gen_btn_start, "clicked", G_CALLBACK(on_gen_start), NULL);
    gtk_box_append(GTK_BOX(svc_row), gen_btn_start);

    gen_btn_stop = gtk_button_new_with_label("Stop");
    g_signal_connect(gen_btn_stop, "clicked", G_CALLBACK(on_gen_stop), NULL);
    gtk_box_append(GTK_BOX(svc_row), gen_btn_stop);

    gen_btn_restart = gtk_button_new_with_label("Restart");
    g_signal_connect(gen_btn_restart, "clicked", G_CALLBACK(on_gen_restart), NULL);
    gtk_box_append(GTK_BOX(svc_row), gen_btn_restart);

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(service_group),
                              general_action_row("Service Controls",
                                                 "Manage the local gateway service expected on this machine.",
                                                 svc_row));

    GtkWidget *paths_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(paths_group), "Paths");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(paths_group));

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(paths_group), section_adw_info_row("Config File", &gen_config_path_label));
    gtk_widget_add_css_class(gen_config_path_label, "monospace");

    GtkWidget *reveal_config_btn = gtk_button_new_with_label("Reveal Config Folder");
    g_signal_connect(reveal_config_btn, "clicked", G_CALLBACK(on_gen_reveal_config), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(paths_group),
                              general_action_row("Config Folder",
                                                 "Open the folder containing the effective config file.",
                                                 reveal_config_btn));

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(paths_group), section_adw_info_row("State Dir", &gen_state_dir_label));
    gtk_widget_add_css_class(gen_state_dir_label, "monospace");

    GtkWidget *reveal_state_btn = gtk_button_new_with_label("Reveal State Folder");
    g_signal_connect(reveal_state_btn, "clicked", G_CALLBACK(on_gen_reveal_state_dir), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(paths_group),
                              general_action_row("State Folder",
                                                 "Open the local state directory used by the companion.",
                                                 reveal_state_btn));

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(paths_group), section_adw_info_row("Profile", &gen_profile_label));

    GtkWidget *companion_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(companion_group), "Companion");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(companion_group));

    GtkWidget *onboard_btn = gtk_button_new_with_label("Re-run Onboarding");
    g_signal_connect(onboard_btn, "clicked", G_CALLBACK(on_gen_rerun_onboarding), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(companion_group),
                              general_action_row("Onboarding",
                                                 "Run the local onboarding flow again for this machine.",
                                                 onboard_btn));

    GtkWidget *quit_btn = gtk_button_new_with_label("Quit OpenClaw Companion");
    gtk_widget_add_css_class(quit_btn, "destructive-action");
    g_signal_connect(quit_btn, "clicked", G_CALLBACK(on_gen_quit), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(companion_group),
                              general_action_row("Quit",
                                                 "Close the Linux companion app.",
                                                 quit_btn));

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void general_refresh(void) {
    if (!gen_status_label) {
        return;
    }

    AppState current = state_get_current();
    RuntimeMode rm = state_get_runtime_mode();
    HealthState *health = state_get_health();
    SystemdState *sys = state_get_systemd();

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(current, rm, &ri, health, sys, &dm);

    gtk_label_set_text(GTK_LABEL(gen_status_label), dm.headline ? dm.headline : "—");
    gtk_label_set_text(GTK_LABEL(gen_runtime_label), dm.runtime_label ? dm.runtime_label : "—");

    if (dm.service_context_notice && gen_service_notice_row && ADW_IS_ACTION_ROW(gen_service_notice_row)) {
        adw_action_row_set_subtitle(ADW_ACTION_ROW(gen_service_notice_row), dm.service_context_notice);
        gtk_widget_set_visible(gen_service_notice_row, TRUE);
    } else {
        gtk_widget_set_visible(gen_service_notice_row, FALSE);
    }

    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg) {
        g_autofree gchar *endpoint = g_strdup_printf("%s:%d", cfg->host ? cfg->host : "127.0.0.1", cfg->port);
        gtk_label_set_text(GTK_LABEL(gen_endpoint_label), endpoint);
    } else {
        gtk_label_set_text(GTK_LABEL(gen_endpoint_label), "—");
    }
    gtk_label_set_text(GTK_LABEL(gen_version_label), dm.gateway_version ? dm.gateway_version : "—");
    gtk_label_set_text(GTK_LABEL(gen_auth_mode_label), (cfg && cfg->auth_mode) ? cfg->auth_mode : "—");
    gtk_label_set_text(GTK_LABEL(gen_auth_source_label), dm.auth_source ? dm.auth_source : "—");
    gtk_label_set_text(GTK_LABEL(gen_unit_label), dm.unit_name ? dm.unit_name : "—");
    gtk_label_set_text(GTK_LABEL(gen_active_state_label), dm.active_state ? dm.active_state : "—");
    gtk_label_set_text(GTK_LABEL(gen_sub_state_label), dm.sub_state ? dm.sub_state : "—");

    g_autofree gchar *profile = NULL;
    systemd_get_runtime_context(&profile, NULL, NULL);

    RuntimeEffectivePaths effective_paths = {0};
    general_resolve_effective_paths(&effective_paths);

    RuntimePathStatus general_paths = {0};
    runtime_path_status_build(effective_paths.effective_config_path,
                              effective_paths.effective_state_dir,
                              NULL,
                              &general_paths);

    g_autofree gchar *profile_display = NULL;
    if (profile && profile[0] != '\0') {
        if (g_utf8_validate(profile, -1, NULL)) {
            profile_display = g_strdup(profile);
        } else {
            profile_display = g_utf8_make_valid(profile, -1);
        }
    } else {
        profile_display = g_strdup("default");
    }

    gtk_label_set_text(GTK_LABEL(gen_config_path_label),
                       general_paths.config_path_resolved ? general_paths.config_path : "—");
    gtk_label_set_text(GTK_LABEL(gen_state_dir_label),
                       general_paths.state_dir_resolved ? general_paths.state_dir : "—");
    gtk_label_set_text(GTK_LABEL(gen_profile_label), profile_display);

    runtime_path_status_clear(&general_paths);
    runtime_effective_paths_clear(&effective_paths);

    refresh_general_connection_mode_controls();
    refresh_general_approval_mode_controls();
    gen_remote_refresh_group_visibility();
    gen_remote_refresh_status_row();

    gtk_widget_set_sensitive(gen_btn_start, dm.can_start);
    gtk_widget_set_sensitive(gen_btn_stop, dm.can_stop);
    gtk_widget_set_sensitive(gen_btn_restart, dm.can_restart);
    gtk_widget_set_sensitive(gen_btn_open_dashboard, dm.can_open_dashboard);
}

static void general_destroy(void) {
    gen_status_label = NULL;
    gen_runtime_label = NULL;
    gen_service_notice_row = NULL;
    ui_combo_row_detach_model(gen_connection_mode_dropdown, (gpointer *)&gen_connection_mode_dropdown_model);
    gen_connection_mode_dropdown = NULL;
    gen_connection_mode_dropdown_model = NULL;
    gen_connection_mode_detail_row = NULL;
    gen_connection_mode_programmatic_change = FALSE;
    ui_combo_row_detach_model(gen_approval_mode_dropdown, (gpointer *)&gen_approval_mode_dropdown_model);
    gen_approval_mode_dropdown = NULL;
    gen_approval_mode_dropdown_model = NULL;
    gen_approval_mode_detail_row = NULL;
    gen_approval_mode_programmatic_change = FALSE;
    gen_endpoint_label = NULL;
    gen_version_label = NULL;
    gen_auth_mode_label = NULL;
    gen_auth_source_label = NULL;
    gen_unit_label = NULL;
    gen_active_state_label = NULL;
    gen_sub_state_label = NULL;
    gen_config_path_label = NULL;
    gen_state_dir_label = NULL;
    gen_profile_label = NULL;
    gen_btn_start = NULL;
    gen_btn_stop = NULL;
    gen_btn_restart = NULL;
    gen_btn_open_dashboard = NULL;

    /* Remote group cleanup. */
    if (gen_remote_endpoint_sub) {
        remote_endpoint_unsubscribe(gen_remote_endpoint_sub);
        gen_remote_endpoint_sub = 0;
    }
    if (gen_remote_probe_cancel) {
        g_cancellable_cancel(gen_remote_probe_cancel);
        g_clear_object(&gen_remote_probe_cancel);
    }
    ui_combo_row_detach_model(gen_remote_transport_dropdown,
                              (gpointer *)&gen_remote_transport_model);
    gen_remote_transport_dropdown = NULL;
    gen_remote_transport_model = NULL;
    gen_remote_transport_programmatic_change = FALSE;
    gen_remote_group = NULL;
    gen_remote_url_row = NULL;
    gen_remote_ssh_target_row = NULL;
    gen_remote_ssh_identity_row = NULL;
    gen_remote_token_row = NULL;
    gen_remote_password_row = NULL;
    gen_remote_status_row = NULL;
    gen_remote_test_btn = NULL;
    gen_remote_apply_btn = NULL;
    gen_remote_test_status_label = NULL;
}

static void general_invalidate(void) {
}

static const SectionController general_controller = {
    .build = general_build,
    .refresh = general_refresh,
    .destroy = general_destroy,
    .invalidate = general_invalidate,
};

const SectionController* section_general_get(void) {
    return &general_controller;
}
