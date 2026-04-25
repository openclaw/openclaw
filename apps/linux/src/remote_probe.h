/*
 * remote_probe.h
 *
 * Pre-switch validation for remote connection settings.
 *
 * Mirrors macOS RemoteGatewayProbe.run():
 *
 *   - direct transport: URL is a valid ws[s] URL whose host serves the
 *     gateway /health endpoint (HTTP 2xx with {"ok": <bool>, ...}).
 *   - ssh transport: a temporary local-forward
 *     (`ssh -o ExitOnForwardFailure=yes -L LOCAL:127.0.0.1:GW_PORT
 *     target -N`) succeeds and the gateway /health endpoint reachable
 *     through the forward returns HTTP 2xx + {"ok": true}.
 *
 * If gateway_port is 0, the SSH probe falls back to the legacy
 * connectivity-only behaviour (`ssh -o BatchMode=yes target echo ok`),
 * which is preserved for tests that exercise SSH-side timeout/escape
 * paths without spinning up an HTTP listener.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_REMOTE_PROBE_H
#define OPENCLAW_LINUX_REMOTE_PROBE_H

#include <gio/gio.h>

typedef enum {
    REMOTE_PROBE_OK = 0,
    REMOTE_PROBE_FAILED,
} RemoteProbeResultKind;

typedef struct {
    RemoteProbeResultKind kind;
    gchar *title;
    gchar *detail;
} RemoteProbeResult;

typedef void (*RemoteProbeCallback)(const RemoteProbeResult *result,
                                    gpointer user_data);

/*
 * Probe a direct ws[s] URL. Validates normalization, then issues
 * GET /health against the equivalent http[s]://host:port and only
 * reports OK on a 2xx + valid health JSON body. Runs asynchronously
 * on the GLib main context.
 */
void remote_probe_direct_async(const gchar *url,
                               GCancellable *cancel,
                               RemoteProbeCallback cb,
                               gpointer user_data);

/*
 * Probe an SSH target.
 *
 *   gateway_port > 0: open a temporary local-forward
 *                     (`ssh -o ExitOnForwardFailure=yes -L L:127.0.0.1:GP
 *                     [-i K] [-p P] target -N`), wait for the forward to
 *                     accept connections, then GET /health through it.
 *                     This validates SSH auth, the forward path, AND
 *                     gateway readiness in one shot — matching macOS
 *                     RemoteGatewayProbe semantics.
 *
 *   gateway_port == 0: legacy connectivity-only probe (`ssh ... echo ok`),
 *                      retained for tests that don't run a gateway.
 */
void remote_probe_ssh_async(const gchar *ssh_user,
                            const gchar *ssh_host,
                            gint ssh_port,
                            const gchar *ssh_identity,
                            gint gateway_port,
                            GCancellable *cancel,
                            RemoteProbeCallback cb,
                            gpointer user_data);

void remote_probe_result_free(RemoteProbeResult *result);

/* Test seams. Production callers MUST NOT use. */
void remote_probe_test_set_ssh_binary(const gchar *path);   /* NULL = reset */
void remote_probe_test_set_ssh_timeout_ms(gint timeout_ms); /* <=0 = reset */

#endif /* OPENCLAW_LINUX_REMOTE_PROBE_H */
