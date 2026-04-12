/*
 * diagnostics.c
 *
 * Diagnostics text payload generation.
 *
 * Provides a canonical formatter detailing gateway client readiness,
 * runtime mode, connectivity, and path/environment truth.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "gateway_client.h"
#include "gateway_config.h"
#include "diagnostics.h"
#include "state.h"
#include "readiness.h"
#include "display_model.h"

static gchar* format_age(gint64 timestamp_us) {
    if (timestamp_us == 0) {
        return g_strdup("Never");
    }
    gint64 now = g_get_real_time();
    gint64 diff_sec = (now - timestamp_us) / 1000000;
    
    if (diff_sec < 5) return g_strdup("Just now");
    if (diff_sec < 60) return g_strdup_printf("%ld seconds ago", diff_sec);
    if (diff_sec < 3600) return g_strdup_printf("%ld minutes ago", diff_sec / 60);
    return g_strdup_printf("%ld hours ago", diff_sec / 3600);
}

gchar* build_diagnostics_text(void) {
    AppState current = state_get_current();
    SystemdState *sys = state_get_systemd();
    HealthState *health = state_get_health();
    const DesktopReadinessSnapshot *snapshot = state_get_readiness_snapshot();

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    g_autofree gchar *health_age = format_age(health->last_updated);

    GString *out = g_string_new(NULL);

    /* Readiness summary */
    g_string_append_printf(out, "=== Readiness ===\n");
    g_string_append_printf(out, "Status: %s\n", ri.classification ? ri.classification : "Unknown");
    if (ri.missing) {
        g_string_append_printf(out, "Detail: %s\n", ri.missing);
    }
    if (ri.next_action) {
        g_string_append_printf(out, "Next:   %s\n", ri.next_action);
    }
    g_string_append_printf(out, "Chat Ready: %s\n", snapshot && snapshot->desktop_chat_ready ? "Yes" : "No");
    g_string_append_printf(out, "Chat Block Reason: %s\n",
                           snapshot ? readiness_chat_block_reason_to_string(snapshot->chat_block_reason) : "Unknown");
    g_string_append_printf(out, "Provider Configured: %s\n",
                           snapshot && snapshot->provider_configured ? "Yes" : "No");
    g_string_append_printf(out, "Default Model Configured: %s\n",
                           snapshot && snapshot->default_model_configured ? "Yes" : "No");
    g_string_append_printf(out, "Model Catalog Available: %s\n",
                           snapshot && snapshot->model_catalog_available ? "Yes" : "No");
    g_string_append_printf(out, "Selected Model Resolved: %s\n",
                           snapshot && snapshot->selected_model_resolved ? "Yes" : "No");
    g_string_append_printf(out, "Agents Available: %s\n",
                           snapshot && snapshot->agents_available ? "Yes" : "No");

    /* Runtime mode */
    RuntimeMode rm = state_get_runtime_mode();
    RuntimeModePresentation rmp;
    runtime_mode_describe(rm, &rmp);
    g_string_append_printf(out, "\n=== Runtime Mode ===\n");
    g_string_append_printf(out, "Mode: %s\n", rmp.label ? rmp.label : "Unknown");
    g_string_append_printf(out, "Detail: %s\n", rmp.explanation ? rmp.explanation : "N/A");
    g_string_append_printf(out, "Listener Proven: %s\n",
        health_state_listener_proven(health) ? "Yes" : "No");

    /* Systemd service context */
    g_string_append_printf(out, "\n=== Systemd Service ===\n");
    g_string_append_printf(out, "Unit: %s\n", sys->unit_name ? sys->unit_name : "N/A");
    g_string_append_printf(out, "ActiveState: %s\n", sys->active_state ? sys->active_state : "Unknown");
    g_string_append_printf(out, "SubState: %s\n", sys->sub_state ? sys->sub_state : "Unknown");

    /* Gateway connectivity */
    g_string_append_printf(out, "\n=== Gateway Connectivity ===\n");
    g_string_append_printf(out, "Source: Native HTTP + WebSocket\n");
    g_string_append_printf(out, "Last updated: %s\n", health_age);
    g_string_append_printf(out, "Endpoint: %s:%d\n",
        health->endpoint_host ? health->endpoint_host : "127.0.0.1",
        health->endpoint_port);
    const char *http_probe_str;
    switch (health->http_probe_result) {
    case HTTP_PROBE_OK:                      http_probe_str = "OK"; break;
    case HTTP_PROBE_CONNECT_REFUSED:         http_probe_str = "Connect Refused"; break;
    case HTTP_PROBE_CONNECT_TIMEOUT:         http_probe_str = "Connect Timeout"; break;
    case HTTP_PROBE_TIMED_OUT_AFTER_CONNECT: http_probe_str = "Timed Out After Connect"; break;
    case HTTP_PROBE_INVALID_RESPONSE:        http_probe_str = "Invalid Response"; break;
    default:                                 http_probe_str = "Unreachable"; break;
    }
    g_string_append_printf(out, "HTTP Health: %s\n", http_probe_str);
    g_string_append_printf(out, "WebSocket: %s\n", health->ws_connected ? "Connected" : "Disconnected");
    g_string_append_printf(out, "RPC OK: %s\n", health->rpc_ok ? "Yes" : "No");
    g_string_append_printf(out, "Auth OK: %s\n", health->auth_ok ? "Yes" : "No");
    g_string_append_printf(out, "Auth Source: %s\n", health->auth_source ? health->auth_source : "N/A");
    g_string_append_printf(out, "Gateway Version: %s\n", health->gateway_version ? health->gateway_version : "N/A");

    /* Configuration */
    g_string_append_printf(out, "\n=== Configuration ===\n");
    const GatewayConfig *cfg = gateway_client_get_config();

    g_autofree gchar *profile = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *config_path = NULL;
    extern void systemd_get_runtime_context(gchar **out_profile, gchar **out_state_dir, gchar **out_config_path);
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    GatewayConfigContext cfg_ctx = {0};
    cfg_ctx.explicit_config_path = config_path;
    cfg_ctx.effective_state_dir = state_dir;
    cfg_ctx.profile = profile;
    g_autofree gchar *resolved_config_path = gateway_config_resolve_path(&cfg_ctx);

    const gchar *effective_config_path = NULL;
    if (cfg && cfg->config_path && cfg->config_path[0] != '\0') {
        effective_config_path = cfg->config_path;
    } else if (resolved_config_path && resolved_config_path[0] != '\0') {
        effective_config_path = resolved_config_path;
    } else if (config_path && config_path[0] != '\0') {
        effective_config_path = config_path;
    }

    RuntimePathStatus paths = {0};
    runtime_path_status_build(effective_config_path, state_dir, NULL, &paths);

    g_string_append_printf(out, "Config Path: %s\n",
                           paths.config_path_resolved ? paths.config_path : "N/A");
    g_string_append_printf(out, "Config Exists: %s\n", paths.config_file_exists ? "Yes" : "No");
    g_string_append_printf(out, "Config Dir Exists: %s\n", paths.config_dir_exists ? "Yes" : "No");
    g_string_append_printf(out, "State Dir: %s\n",
                           paths.state_dir_resolved ? paths.state_dir : "N/A");
    g_string_append_printf(out, "State Dir Exists: %s\n", paths.state_dir_exists ? "Yes" : "No");
    g_string_append_printf(out, "Setup Detected: %s\n", health->setup_detected ? "Yes" : "No");
    g_string_append_printf(out, "Config Valid: %s\n", health->config_valid ? "Yes" : "No");
    
    g_string_append_printf(out, "Wizard Onboard Marker: %s\n", health->has_wizard_onboard_marker ? "Yes" : "No");
    if (!health->has_wizard_onboard_marker) {
        g_string_append_printf(out, "  Reason: %s\n", health->wizard_marker_fail_reason ? health->wizard_marker_fail_reason : "N/A");
    }
    
    g_string_append_printf(out, "wizard.lastRunCommand: %s\n", health->wizard_last_run_command ? health->wizard_last_run_command : "N/A");
    g_string_append_printf(out, "wizard.lastRunAt: %s\n", health->wizard_last_run_at ? health->wizard_last_run_at : "N/A");
    g_string_append_printf(out, "wizard.lastRunMode: %s\n", health->wizard_last_run_mode ? health->wizard_last_run_mode : "N/A");
    g_string_append_printf(out, "Has Model Config: %s (diagnostic only)\n", health->has_model_config ? "Yes" : "No");
    
    g_string_append_printf(out, "Service Installed: %s\n", sys->installed ? "Yes" : "No");
    g_string_append_printf(out, "Config Issues: %d\n", health->config_issues_count);
    g_string_append_printf(out, "Last Error: %s\n", health->last_error ? health->last_error : "None");

    runtime_path_status_clear(&paths);

    return g_string_free(out, FALSE);
}
