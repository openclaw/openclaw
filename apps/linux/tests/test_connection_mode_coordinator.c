/*
 * test_connection_mode_coordinator.c
 *
 * Regression: when the resolver hands the coordinator
 * effective_mode = REMOTE but config->mode is NULL (i.e. remote was
 * inferred from gateway.remote.url or persisted product state, not
 * declared as gateway.mode == "remote"), the coordinator must still
 * prefer gateway.remote.token / gateway.remote.password over the
 * local gateway.auth.token / gateway.auth.password when publishing
 * the remote endpoint.
 *
 * Pre-fix this case fell through to the local gateway.auth.token,
 * which is the wrong credential for the remote gateway.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>

#include "../src/connection_mode_coordinator.h"
#include "../src/gateway_config.h"
#include "../src/gateway_remote_config.h"
#include "../src/remote_endpoint.h"

/*
 * connection_mode_coordinator.c declares these as extern symbols
 * provided by systemd.c. The unit under test never spawns or stops
 * a real gateway in this scenario, but the symbols must link.
 */
void systemd_stop_gateway(void) { /* no-op for tests */ }
void systemd_start_gateway(void) { /* no-op for tests */ }

static void test_remote_credential_precedence_when_mode_is_null(void) {
    /*
     * Build a stack-allocated GatewayConfig that mirrors what
     * connection_mode_resolver produces for a gateway.remote.url-only
     * config (gateway.mode absent, but gateway.remote present and
     * declaring direct transport).
     *
     * No heap allocation is required because the coordinator only
     * borrows these strings during the apply call and we tear it down
     * at the end of the test before scope exit.
     */
    GatewayConfig cfg = {0};
    cfg.valid = TRUE;
    cfg.mode = NULL;
    cfg.host = "127.0.0.1";
    cfg.port = 18789;
    cfg.token = "local-token";
    cfg.password = NULL;

    cfg.remote_present = TRUE;
    cfg.remote_transport = REMOTE_TRANSPORT_DIRECT;
    cfg.remote_url = "wss://gw.example.com:8443";
    cfg.remote_url_host = "gw.example.com";
    cfg.remote_url_port = 8443;
    cfg.remote_url_tls = TRUE;
    cfg.remote_token = "remote-token";
    cfg.remote_password = NULL;

    /*
     * Apply the resolver's effective_mode = REMOTE. The coordinator
     * normally consults gateway_config_remote_effective_token(), which
     * keys off config->mode == "remote" — this test deliberately
     * leaves config->mode NULL to lock in that the coordinator's own
     * helper, not the gateway_config helper, drives the publish.
     */
    connection_mode_coordinator_apply(&cfg, PRODUCT_CONNECTION_MODE_REMOTE);

    const RemoteEndpointSnapshot *snap = remote_endpoint_get();
    g_assert_nonnull(snap);
    g_assert_cmpint(snap->kind, ==, REMOTE_ENDPOINT_READY);
    g_assert_cmpstr(snap->host, ==, "gw.example.com");
    g_assert_cmpint(snap->port, ==, 8443);
    g_assert_true(snap->tls);

    /* The critical assertion: remote_token must win over local token. */
    g_assert_nonnull(snap->token);
    g_assert_cmpstr(snap->token, ==, "remote-token");

    /* Tear down — coordinator owns the published endpoint state. */
    connection_mode_coordinator_shutdown();
    remote_endpoint_shutdown();
}

static void test_remote_falls_back_to_local_token_when_remote_empty(void) {
    /*
     * The coordinator helpers are defined to fall back to
     * gateway.auth.token when gateway.remote.token is empty/missing.
     * This guards against a regression that would publish "" as the
     * remote token whenever remote_token was absent.
     */
    GatewayConfig cfg = {0};
    cfg.valid = TRUE;
    cfg.mode = NULL;
    cfg.host = "127.0.0.1";
    cfg.port = 18789;
    cfg.token = "fallback-local-token";

    cfg.remote_present = TRUE;
    cfg.remote_transport = REMOTE_TRANSPORT_DIRECT;
    cfg.remote_url = "wss://gw.example.com:8443";
    cfg.remote_url_host = "gw.example.com";
    cfg.remote_url_port = 8443;
    cfg.remote_url_tls = TRUE;
    cfg.remote_token = NULL;     /* explicit absence */
    cfg.remote_password = NULL;

    connection_mode_coordinator_apply(&cfg, PRODUCT_CONNECTION_MODE_REMOTE);

    const RemoteEndpointSnapshot *snap = remote_endpoint_get();
    g_assert_nonnull(snap);
    g_assert_cmpint(snap->kind, ==, REMOTE_ENDPOINT_READY);
    g_assert_cmpstr(snap->token, ==, "fallback-local-token");

    connection_mode_coordinator_shutdown();
    remote_endpoint_shutdown();
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/coordinator/remote_token_overrides_local_when_mode_is_null",
                    test_remote_credential_precedence_when_mode_is_null);
    g_test_add_func("/coordinator/remote_token_falls_back_to_local",
                    test_remote_falls_back_to_local_token_when_remote_empty);
    return g_test_run();
}
