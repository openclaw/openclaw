/*
 * gateway_http.h
 *
 * Native HTTP health checking for the OpenClaw Linux Companion App.
 *
 * Performs async GET /health against the local gateway endpoint using
 * a GLib-friendly HTTP transport (libsoup-3.0).
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_GATEWAY_HTTP_H
#define OPENCLAW_LINUX_GATEWAY_HTTP_H

#include <glib.h>

typedef struct {
    gboolean ok;
    gboolean healthy;
    gchar *version;
    gchar *error;
} GatewayHealthResult;

typedef void (*GatewayHealthCallback)(const GatewayHealthResult *result, gpointer user_data);

void gateway_http_init(void);
void gateway_http_check_health(const gchar *base_url, GatewayHealthCallback callback, gpointer user_data);
void gateway_http_shutdown(void);
void gateway_health_result_clear(GatewayHealthResult *result);

#endif /* OPENCLAW_LINUX_GATEWAY_HTTP_H */
