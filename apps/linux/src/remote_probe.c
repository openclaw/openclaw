/*
 * remote_probe.c
 *
 * Async validators for remote connection settings.
 *
 * Direct probe (gateway_port irrelevant):
 *   - normalize URL via gateway_remote_config
 *   - issue GET http[s]://host:port/health via gateway_http
 *   - report OK only on 2xx + valid {"ok": <bool>, …} body
 *
 * SSH probe:
 *   - When gateway_port > 0:
 *       * pick a free loopback port
 *       * spawn `ssh -o ExitOnForwardFailure=yes -o BatchMode=yes
 *               -L LOCAL:127.0.0.1:GW_PORT [-i K] [-p P] target -N`
 *       * poll the loopback port until it accepts a connection (or
 *         until ssh exits / our top-level timeout fires)
 *       * GET http://127.0.0.1:LOCAL/health via gateway_http
 *       * SIGTERM/SIGKILL the ssh child and deliver the result
 *
 *   - When gateway_port == 0 (legacy / test mode):
 *       * spawn `ssh -o BatchMode=yes target echo ok` and report on its
 *         exit code, matching the original Linux v1 behaviour. Used by
 *         the SSH timeout-resistance regression tests, which do not
 *         spin up an HTTP listener on the other side.
 *
 * Both paths run on the GLib main context and complete via a callback
 * with a human-readable title/detail suitable for the General-section
 * UX.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "remote_probe.h"

#include <gio/gio.h>
#include <signal.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#include "gateway_http.h"
#include "gateway_remote_config.h"
#include "log.h"
#include "remote_port_check.h"

#define PROBE_CONNECT_TIMEOUT_S 5
#define PROBE_SSH_TIMEOUT_MS_DEFAULT 8000

/*
 * Grace period after SIGTERM before we escalate to SIGKILL
 * (g_subprocess_force_exit). Keeps a well-behaved ssh child a chance
 * to drain before we hard-kill, while bounding the UI wait when the
 * child traps/ignores TERM. Must stay well below typical UI watchdogs.
 */
#define PROBE_SSH_KILL_GRACE_MS_DEFAULT 500

/*
 * Forward-wait poll cadence and overall budget. The local-forward
 * usually settles within tens of milliseconds; we poll at 100 ms and
 * give up after 5000 ms which is well inside the SSH probe timeout.
 */
#define PROBE_FORWARD_POLL_MS    100
#define PROBE_FORWARD_BUDGET_MS  5000

static gchar *g_probe_ssh_binary_override = NULL;
static gint   g_probe_ssh_timeout_ms_override = 0;

void remote_probe_test_set_ssh_binary(const gchar *path) {
    g_clear_pointer(&g_probe_ssh_binary_override, g_free);
    if (path) g_probe_ssh_binary_override = g_strdup(path);
}

void remote_probe_test_set_ssh_timeout_ms(gint timeout_ms) {
    g_probe_ssh_timeout_ms_override = (timeout_ms > 0) ? timeout_ms : 0;
}

static const gchar* probe_ssh_binary(void) {
    return g_probe_ssh_binary_override ? g_probe_ssh_binary_override : "/usr/bin/ssh";
}

static gint probe_ssh_timeout_ms(void) {
    return g_probe_ssh_timeout_ms_override > 0
        ? g_probe_ssh_timeout_ms_override
        : PROBE_SSH_TIMEOUT_MS_DEFAULT;
}

typedef struct {
    RemoteProbeCallback cb;
    gpointer user_data;
    GCancellable *cancel;

    /* True once we've delivered a result; future async callbacks must
     * become no-ops. */
    gboolean delivered;

    /* Direct probe (HTTP /health). */
    gchar *url;          /* normalized ws[s]:// — used in titles      */
    gchar *http_url;     /* http[s]://host:port — fed to gateway_http */
    gchar *host;         /* parsed host (diagnostics)                 */
    gint port;           /* parsed port (diagnostics)                 */
    gboolean tls;

    /* SSH probe (legacy echo path + /health-via-forward path). */
    GSubprocess *proc;
    guint timeout_source_id;
    guint kill_source_id;
    gboolean timed_out;

    /* SSH /health-via-forward fields. */
    gint gateway_port;
    gint local_port;
    guint forward_poll_source_id;
    gint64 forward_wait_started_us;
    gboolean health_in_flight;
    /*
     * Ownership handoff flag for the SSH /health path.
     *
     * The lifetime of ProbeCtx in that path is shared between two
     * async callbacks: g_subprocess_wait_async (on_ssh_forward_wait)
     * and gateway_http_check_health (on_forward_health). Whoever
     * finishes last is responsible for probe_ctx_free.
     *
     * Legal orderings:
     *
     *   (A) health callback first, wait callback later
     *       on_forward_health → deliver_keep + teardown_forward_ssh
     *       ...later ssh exits → on_ssh_forward_wait → probe_ctx_free
     *
     *   (B) wait callback first while health still in flight
     *       on_ssh_forward_wait → sets wait_completed=TRUE, returns
     *       ...later health responds → on_forward_health → deliver_keep
     *                                  → probe_ctx_free
     *
     * Without this flag, case (B) leaks ctx when the health callback
     * runs after the subprocess wait has already returned, because no
     * further wait callback exists to free it.
     */
    gboolean wait_completed;
} ProbeCtx;

static void probe_ctx_free(ProbeCtx *ctx) {
    if (!ctx) return;
    if (ctx->timeout_source_id) {
        g_source_remove(ctx->timeout_source_id);
        ctx->timeout_source_id = 0;
    }
    if (ctx->kill_source_id) {
        g_source_remove(ctx->kill_source_id);
        ctx->kill_source_id = 0;
    }
    if (ctx->forward_poll_source_id) {
        g_source_remove(ctx->forward_poll_source_id);
        ctx->forward_poll_source_id = 0;
    }
    g_clear_object(&ctx->cancel);
    g_clear_object(&ctx->proc);
    g_free(ctx->url);
    g_free(ctx->http_url);
    g_free(ctx->host);
    g_free(ctx);
}

void remote_probe_result_free(RemoteProbeResult *result) {
    if (!result) return;
    g_free(result->title);
    g_free(result->detail);
    g_free(result);
}

static void deliver(ProbeCtx *ctx,
                    RemoteProbeResultKind kind,
                    gchar *title,
                    gchar *detail) {
    /*
     * Be defensive about late callbacks: if a result has already been
     * delivered (e.g. health response arrives after we tore down the
     * forward), drop the call rather than double-deliver.
     */
    if (ctx->delivered) {
        g_free(title);
        g_free(detail);
        return;
    }
    ctx->delivered = TRUE;
    RemoteProbeResult r = { .kind = kind, .title = title, .detail = detail };
    if (ctx->cb) ctx->cb(&r, ctx->user_data);
    g_free(title);
    g_free(detail);
    probe_ctx_free(ctx);
}

/*
 * "Defer-and-free" delivery: like deliver() but the actual probe_ctx_free
 * happens after the gateway_http callback has fully returned. Used in
 * the /health path where gateway_http still owns the SoupMessage at
 * the time it invokes our callback.
 */
static void deliver_keep(ProbeCtx *ctx,
                         RemoteProbeResultKind kind,
                         gchar *title,
                         gchar *detail) {
    if (ctx->delivered) {
        g_free(title);
        g_free(detail);
        return;
    }
    ctx->delivered = TRUE;
    RemoteProbeResult r = { .kind = kind, .title = title, .detail = detail };
    if (ctx->cb) ctx->cb(&r, ctx->user_data);
    /*
     * Continued below — deliver_keep deliberately does NOT free ctx.
     * Callers in the /health path use this when the in-flight health
     * callback (or the wait callback racing it) still owns ctx.
     */
    g_free(title);
    g_free(detail);
}

/*
 * Convenience wrapper that delivers the canonical "SSH probe timed out"
 * result via deliver_keep. Used by on_ssh_forward_wait when the probe
 * timeout fires while gateway_http_check_health is still in flight —
 * the SSH timeout must dominate any later /health verdict, but we
 * cannot probe_ctx_free until the in-flight health callback returns
 * (it still holds ctx as user_data through the SoupSession queue).
 */
static void deliver_timeout_keep(ProbeCtx *ctx) {
    deliver_keep(ctx,
                 REMOTE_PROBE_FAILED,
                 g_strdup("SSH probe timed out"),
                 g_strdup_printf("no response within %d ms",
                                 probe_ssh_timeout_ms()));
}

/* ── Direct probe (HTTP /health) ── */

static void on_direct_health(const GatewayHealthResult *result,
                             gpointer user_data) {
    ProbeCtx *ctx = (ProbeCtx *)user_data;
    if (!result || !result->ok) {
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("Could not reach gateway /health"),
                g_strdup(result && result->error ? result->error
                                                 : "no response"));
        return;
    }
    if (!result->healthy) {
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("Gateway /health reported not healthy"),
                g_strdup_printf("%s://%s:%d/health returned ok=false",
                                ctx->tls ? "https" : "http",
                                ctx->host ? ctx->host : "?",
                                ctx->port));
        return;
    }
    deliver(ctx, REMOTE_PROBE_OK,
            g_strdup(ctx->tls ? "wss:// gateway is healthy"
                              : "ws:// gateway is healthy"),
            g_strdup_printf("%s://%s:%d/health returned ok=true%s%s",
                            ctx->tls ? "https" : "http",
                            ctx->host ? ctx->host : "?",
                            ctx->port,
                            result->version ? " v=" : "",
                            result->version ? result->version : ""));
}

void remote_probe_direct_async(const gchar *url,
                               GCancellable *cancel,
                               RemoteProbeCallback cb,
                               gpointer user_data) {
    ProbeCtx *ctx = g_new0(ProbeCtx, 1);
    ctx->cb = cb;
    ctx->user_data = user_data;
    ctx->cancel = cancel ? g_object_ref(cancel) : NULL;

    gchar *host = NULL;
    gint port = 0;
    gboolean tls = FALSE;
    ctx->url = gateway_remote_config_normalize_url(url, &host, &port, &tls);
    if (!ctx->url) {
        g_free(host);
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("Invalid gateway URL"),
                g_strdup("URL must be a ws:// (loopback only) or wss:// URL"));
        return;
    }
    ctx->host = host;
    ctx->port = port;
    ctx->tls = tls;
    ctx->http_url = g_strdup_printf("%s://%s:%d", tls ? "https" : "http",
                                    host, port);

    gateway_http_check_health(ctx->http_url, on_direct_health, ctx);
}

/* ── SSH probe — legacy "echo ok" path (gateway_port == 0) ── */

static gboolean on_ssh_kill_escalate(gpointer user_data) {
    ProbeCtx *ctx = (ProbeCtx *)user_data;
    ctx->kill_source_id = 0;
    if (ctx->proc) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_REMOTE,
                    "remote_probe SSH probe did not exit within %d ms after SIGTERM — "
                    "escalating to SIGKILL",
                    PROBE_SSH_KILL_GRACE_MS_DEFAULT);
        g_subprocess_force_exit(ctx->proc);
    }
    return G_SOURCE_REMOVE;
}

static gboolean on_ssh_timeout(gpointer user_data) {
    ProbeCtx *ctx = (ProbeCtx *)user_data;
    ctx->timeout_source_id = 0;
    ctx->timed_out = TRUE;
    if (!ctx->proc) return G_SOURCE_REMOVE;

    OC_LOG_WARN(OPENCLAW_LOG_CAT_REMOTE,
                "remote_probe SSH probe exceeded %d ms — terminating",
                probe_ssh_timeout_ms());
    g_subprocess_send_signal(ctx->proc, SIGTERM);

    if (!ctx->kill_source_id) {
        ctx->kill_source_id = g_timeout_add(PROBE_SSH_KILL_GRACE_MS_DEFAULT,
                                            on_ssh_kill_escalate, ctx);
    }
    return G_SOURCE_REMOVE;
}

/* Pull a short stderr snapshot from the ssh subprocess. Caller frees. */
static gchar* read_ssh_stderr_snippet(GSubprocess *proc) {
    GInputStream *err_stream = g_subprocess_get_stderr_pipe(proc);
    if (!err_stream) return NULL;
    g_autoptr(GOutputStream) mem = g_memory_output_stream_new_resizable();
    g_output_stream_splice(mem, err_stream,
                           G_OUTPUT_STREAM_SPLICE_CLOSE_SOURCE,
                           NULL, NULL);
    gsize buf_len = g_memory_output_stream_get_data_size(
        G_MEMORY_OUTPUT_STREAM(mem));
    gchar *raw = g_memory_output_stream_steal_data(
        G_MEMORY_OUTPUT_STREAM(mem));
    if (!raw) return NULL;
    gchar *terminated = g_realloc(raw, buf_len + 1);
    terminated[buf_len] = '\0';
    g_strstrip(terminated);
    return terminated;
}

static void on_ssh_echo_wait(GObject *source, GAsyncResult *result,
                             gpointer user_data) {
    ProbeCtx *ctx = (ProbeCtx *)user_data;
    if (ctx->timeout_source_id) {
        g_source_remove(ctx->timeout_source_id);
        ctx->timeout_source_id = 0;
    }
    if (ctx->kill_source_id) {
        g_source_remove(ctx->kill_source_id);
        ctx->kill_source_id = 0;
    }
    if (ctx->timed_out) {
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("SSH probe timed out"),
                g_strdup_printf("no response within %d ms", probe_ssh_timeout_ms()));
        return;
    }
    g_autoptr(GError) err = NULL;
    gboolean ok = g_subprocess_wait_finish(G_SUBPROCESS(source), result, &err);
    if (!ok && err) {
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("SSH probe failed"),
                g_strdup(err->message));
        return;
    }
    if (!g_subprocess_get_if_exited(G_SUBPROCESS(source))) {
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("SSH probe failed"),
                g_strdup("ssh terminated abnormally"));
        return;
    }
    gint exit_status = g_subprocess_get_exit_status(G_SUBPROCESS(source));
    if (exit_status == 0) {
        deliver(ctx, REMOTE_PROBE_OK,
                g_strdup("SSH target reachable"),
                g_strdup("ssh echo ok returned 0"));
        return;
    }

    g_autofree gchar *buf = read_ssh_stderr_snippet(G_SUBPROCESS(source));
    gchar *detail = g_strdup_printf("exit %d%s%s",
                                    exit_status,
                                    (buf && buf[0]) ? ": " : "",
                                    (buf && buf[0]) ? buf : "");
    deliver(ctx, REMOTE_PROBE_FAILED,
            g_strdup("SSH probe failed"),
            detail);
}

static void spawn_ssh_echo_probe(ProbeCtx *ctx,
                                 const gchar *ssh_user,
                                 const gchar *ssh_host,
                                 gint ssh_port,
                                 const gchar *ssh_identity) {
    GPtrArray *argv = g_ptr_array_new_with_free_func(g_free);
    g_ptr_array_add(argv, g_strdup(probe_ssh_binary()));
    g_ptr_array_add(argv, g_strdup("-o"));
    g_ptr_array_add(argv, g_strdup("BatchMode=yes"));
    g_ptr_array_add(argv, g_strdup("-o"));
    g_ptr_array_add(argv, g_strdup("ConnectTimeout=5"));
    g_ptr_array_add(argv, g_strdup("-o"));
    g_ptr_array_add(argv, g_strdup("StrictHostKeyChecking=accept-new"));
    if (ssh_port > 0 && ssh_port != 22) {
        g_ptr_array_add(argv, g_strdup("-p"));
        g_ptr_array_add(argv, g_strdup_printf("%d", ssh_port));
    }
    if (ssh_identity && ssh_identity[0] != '\0') {
        g_ptr_array_add(argv, g_strdup("-i"));
        g_ptr_array_add(argv, g_strdup(ssh_identity));
    }
    if (ssh_user && ssh_user[0] != '\0') {
        g_ptr_array_add(argv, g_strdup_printf("%s@%s", ssh_user, ssh_host));
    } else {
        g_ptr_array_add(argv, g_strdup(ssh_host));
    }
    g_ptr_array_add(argv, g_strdup("echo"));
    g_ptr_array_add(argv, g_strdup("ok"));
    g_ptr_array_add(argv, NULL);
    gchar **argv_s = (gchar **)g_ptr_array_free(argv, FALSE);

    g_autoptr(GSubprocessLauncher) launcher = g_subprocess_launcher_new(
        G_SUBPROCESS_FLAGS_STDOUT_SILENCE | G_SUBPROCESS_FLAGS_STDERR_PIPE);
    g_autoptr(GError) err = NULL;
    ctx->proc = g_subprocess_launcher_spawnv(launcher,
                                             (const gchar * const *)argv_s, &err);
    g_strfreev(argv_s);
    if (!ctx->proc) {
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("Could not run ssh"),
                g_strdup(err ? err->message : "spawn failed"));
        return;
    }

    ctx->timeout_source_id = g_timeout_add(probe_ssh_timeout_ms(),
                                           on_ssh_timeout, ctx);
    g_subprocess_wait_async(ctx->proc, ctx->cancel, on_ssh_echo_wait, ctx);
}

/* ── SSH probe — /health-via-forward path (gateway_port > 0) ── */

static void teardown_forward_ssh(ProbeCtx *ctx) {
    if (!ctx->proc) return;
    /* Soft TERM first; SIGKILL via the existing escalation path if it
     * doesn't exit. We don't wait on the subprocess here — the callback
     * we registered with wait_async will fire and free ctx. */
    g_subprocess_send_signal(ctx->proc, SIGTERM);
    if (!ctx->kill_source_id) {
        ctx->kill_source_id = g_timeout_add(PROBE_SSH_KILL_GRACE_MS_DEFAULT,
                                            on_ssh_kill_escalate, ctx);
    }
}

static void on_forward_health(const GatewayHealthResult *result,
                              gpointer user_data) {
    ProbeCtx *ctx = (ProbeCtx *)user_data;
    ctx->health_in_flight = FALSE;

    if (ctx->delivered) {
        /*
         * A previous callback already produced the operator-visible
         * result (typically on_ssh_forward_wait running the timeout-
         * dominance path via deliver_timeout_keep, or on_forward_poll
         * publishing an early ssh-exit failure). Two ownership cases:
         *
         *  - wait_completed=TRUE: the wait callback already returned
         *    without freeing because it knew we were still in flight.
         *    We are the last subscriber and must free ctx now.
         *
         *  - wait_completed=FALSE: the subprocess has not exited yet
         *    (e.g. on_forward_poll's early ssh-exit handler delivered
         *    a failure but the wait callback for the same exit hasn't
         *    been queued yet, OR teardown is still in progress). The
         *    pending wait callback is the last subscriber and will
         *    free ctx when it runs.
         */
        if (ctx->wait_completed) {
            probe_ctx_free(ctx);
        }
        return;
    }

    /*
     * Observation: gateway_http still owns the SoupMessage during this
     * callback, so we must not free ctx before returning to its loop.
     * deliver_keep() satisfies that constraint (it marks delivered=TRUE
     * but does not probe_ctx_free). Final disposition — free now vs.
     * hand off to the wait callback — is decided below, after delivery.
     */
    if (ctx->timed_out) {
        /*
         * Timeout dominance, reverse-ordering branch.
         *
         * If on_ssh_timeout fired (and SIGTERM/SIGKILL'd ssh) before
         * the SoupSession queued our callback, we may arrive here
         * with a synthetic "no response" or connection-broken result.
         * The operator-visible verdict must still be "SSH probe timed
         * out" — the /health failure is a downstream symptom of the
         * timeout, not a fresh failure mode. Deliver the timeout
         * verdict instead of the /health one.
         */
        deliver_timeout_keep(ctx);
    } else if (!result || !result->ok) {
        deliver_keep(ctx, REMOTE_PROBE_FAILED,
                     g_strdup("Gateway /health unreachable through SSH forward"),
                     g_strdup(result && result->error ? result->error
                                                      : "no response"));
    } else if (!result->healthy) {
        deliver_keep(ctx, REMOTE_PROBE_FAILED,
                     g_strdup("Gateway /health reported not healthy"),
                     g_strdup_printf("forward 127.0.0.1:%d/health returned ok=false",
                                     ctx->local_port));
    } else {
        deliver_keep(ctx, REMOTE_PROBE_OK,
                     g_strdup("SSH target ready (gateway healthy)"),
                     g_strdup_printf("forward 127.0.0.1:%d → gateway:%d /health "
                                     "returned ok=true%s%s",
                                     ctx->local_port, ctx->gateway_port,
                                     result->version ? " v=" : "",
                                     result->version ? result->version : ""));
    }

    /*
     * Ownership handoff — see the wait_completed docstring on ProbeCtx.
     *
     * Case B: wait callback already ran while we were in flight. No
     * future callback will observe ctx, so we are the last subscriber
     * and must free it now. The subprocess is already dead; teardown
     * would be a no-op but is also unnecessary.
     *
     * Case A: subprocess is still running. Start teardown (soft TERM +
     * SIGKILL escalation) and return; the eventual on_ssh_forward_wait
     * will observe delivered=TRUE and free ctx.
     */
    if (ctx->wait_completed) {
        probe_ctx_free(ctx);
        return;
    }
    teardown_forward_ssh(ctx);
}

static gboolean on_forward_poll(gpointer user_data) {
    ProbeCtx *ctx = (ProbeCtx *)user_data;

    if (ctx->delivered) {
        ctx->forward_poll_source_id = 0;
        return G_SOURCE_REMOVE;
    }

    /*
     * Did ssh exit early (forward refused, auth failure, etc.)?
     *
     * NOTE: g_subprocess_get_if_exited() asserts subprocess->pid == 0,
     * i.e. it MUST NOT be called before g_subprocess_wait_async has
     * completed. Calling it from a poll while the subprocess is still
     * being awaited aborts the test runner under G_DEBUG=fatal-criticals
     * (the meson default). Use POSIX kill(pid, 0) for a non-destructive
     * liveness probe; the eventual on_ssh_forward_wait callback will
     * surface the exit status with the full stderr snippet.
     */
    if (ctx->proc) {
        const gchar *pid_str = g_subprocess_get_identifier(ctx->proc);
        if (pid_str && pid_str[0] != '\0') {
            pid_t pid = (pid_t)g_ascii_strtoll(pid_str, NULL, 10);
            if (pid > 1 && kill(pid, 0) != 0) {
                /*
                 * Process is gone (ESRCH) — let the wait callback
                 * deliver the precise exit-status diagnostic. Stop
                 * polling so we don't busy-loop while we wait. */
                ctx->forward_poll_source_id = 0;
                return G_SOURCE_REMOVE;
            }
        }
    }

    /* Has the local-forward begun accepting connections? */
    if (remote_port_check_loopback_listening(ctx->local_port, 50)) {
        ctx->forward_poll_source_id = 0;
        ctx->health_in_flight = TRUE;
        g_autofree gchar *base = g_strdup_printf("http://127.0.0.1:%d",
                                                 ctx->local_port);
        gateway_http_check_health(base, on_forward_health, ctx);
        return G_SOURCE_REMOVE;
    }

    /* Forward-wait budget — covers DNS/auth handshake without leaving
     * the user staring at a spinner forever. */
    gint64 elapsed_ms =
        (g_get_monotonic_time() - ctx->forward_wait_started_us) / 1000;
    if (elapsed_ms > PROBE_FORWARD_BUDGET_MS) {
        ctx->forward_poll_source_id = 0;

        /*
         * ssh still has g_subprocess_wait_async() registered with ctx
         * as user_data, and teardown_forward_ssh(ctx) is about to
         * dereference ctx. We therefore MUST NOT use deliver() here
         * (which would probe_ctx_free(ctx) before teardown and before
         * the wait callback). Use deliver_keep() to publish the result
         * without freeing, then terminate ssh; on_ssh_forward_wait()
         * remains the final owner and will probe_ctx_free(ctx) once
         * the subprocess exits.
         */
        deliver_keep(ctx, REMOTE_PROBE_FAILED,
                     g_strdup("SSH local-forward did not become ready"),
                     g_strdup_printf(
                         "127.0.0.1:%d still not accepting after %lld ms",
                         ctx->local_port, (long long)elapsed_ms));
        teardown_forward_ssh(ctx);
        return G_SOURCE_REMOVE;
    }

    return G_SOURCE_CONTINUE;
}

static void on_ssh_forward_wait(GObject *source, GAsyncResult *result,
                                gpointer user_data) {
    ProbeCtx *ctx = (ProbeCtx *)user_data;
    if (ctx->timeout_source_id) {
        g_source_remove(ctx->timeout_source_id);
        ctx->timeout_source_id = 0;
    }
    if (ctx->kill_source_id) {
        g_source_remove(ctx->kill_source_id);
        ctx->kill_source_id = 0;
    }
    if (ctx->forward_poll_source_id) {
        g_source_remove(ctx->forward_poll_source_id);
        ctx->forward_poll_source_id = 0;
    }

    g_autoptr(GError) err = NULL;
    g_subprocess_wait_finish(G_SUBPROCESS(source), result, &err);
    /*
     * Mark the subprocess wait as completed BEFORE any early returns.
     * on_forward_health consults this flag to decide whether to free
     * ctx itself (case B) or hand off to a future wait callback (case
     * A — not applicable once this point has been reached).
     */
    ctx->wait_completed = TRUE;

    /*
     * Timeout dominance.
     *
     * If the SSH probe timeout fired (on_ssh_timeout set timed_out=TRUE
     * and SIGTERM/SIGKILL'd ssh, which is what brought us here), the
     * operator-visible result MUST be "SSH probe timed out" — not
     * whatever a later /health callback would have produced. We
     * therefore deliver the timeout NOW even when the /health request
     * is still in flight.
     *
     * Lifetime: when health is still in flight we must not free ctx
     * here (gateway_http's SoupSession still owns a callback bound to
     * ctx). on_forward_health observes wait_completed && delivered and
     * frees ctx itself.
     */
    if (ctx->timed_out) {
        if (ctx->health_in_flight) {
            if (!ctx->delivered) {
                deliver_timeout_keep(ctx);
            }
            /* Hand off to on_forward_health (which will free). */
            return;
        }

        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("SSH probe timed out"),
                g_strdup_printf("no response within %d ms",
                                probe_ssh_timeout_ms()));
        return;
    }

    if (ctx->health_in_flight && !ctx->delivered) {
        /*
         * Case B: /health request is still outstanding and nothing has
         * been delivered yet. Return without freeing — on_forward_health
         * will observe wait_completed=TRUE and call probe_ctx_free when
         * it runs. Freeing here would leave the in-flight SoupMessage
         * pointing at released memory.
         */
        return;
    }
    if (ctx->health_in_flight && ctx->delivered) {
        /*
         * Delivery already happened (early ssh-exit failure path) but
         * the health request is still in flight. Hand off ownership to
         * on_forward_health, which will observe wait_completed=TRUE and
         * free ctx. Freeing here would leave the SoupSession callback
         * bound to released memory.
         */
        return;
    }

    if (!ctx->delivered) {
        gint exit_status = g_subprocess_get_if_exited(G_SUBPROCESS(source))
            ? g_subprocess_get_exit_status(G_SUBPROCESS(source))
            : -1;
        g_autofree gchar *buf = read_ssh_stderr_snippet(G_SUBPROCESS(source));
        gchar *detail = g_strdup_printf("ssh -L exited with code %d%s%s",
                                        exit_status,
                                        (buf && buf[0]) ? ": " : "",
                                        (buf && buf[0]) ? buf : "");
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("SSH local-forward failed"),
                detail);
        return;
    }

    /* Result already delivered earlier (success or forward-wait
     * timeout) — just free. */
    probe_ctx_free(ctx);
}

static void spawn_ssh_forward_probe(ProbeCtx *ctx,
                                    const gchar *ssh_user,
                                    const gchar *ssh_host,
                                    gint ssh_port,
                                    const gchar *ssh_identity) {
    ctx->local_port = remote_port_check_pick_loopback_port();
    if (ctx->local_port <= 0) {
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("Could not allocate a local port"),
                g_strdup("kernel refused bind(127.0.0.1:0)"));
        return;
    }

    g_autofree gchar *forward_spec = g_strdup_printf(
        "127.0.0.1:%d:127.0.0.1:%d", ctx->local_port, ctx->gateway_port);

    GPtrArray *argv = g_ptr_array_new_with_free_func(g_free);
    g_ptr_array_add(argv, g_strdup(probe_ssh_binary()));
    g_ptr_array_add(argv, g_strdup("-o"));
    g_ptr_array_add(argv, g_strdup("BatchMode=yes"));
    g_ptr_array_add(argv, g_strdup("-o"));
    g_ptr_array_add(argv, g_strdup("ConnectTimeout=5"));
    g_ptr_array_add(argv, g_strdup("-o"));
    g_ptr_array_add(argv, g_strdup("StrictHostKeyChecking=accept-new"));
    g_ptr_array_add(argv, g_strdup("-o"));
    g_ptr_array_add(argv, g_strdup("ExitOnForwardFailure=yes"));
    g_ptr_array_add(argv, g_strdup("-N"));
    g_ptr_array_add(argv, g_strdup("-L"));
    g_ptr_array_add(argv, g_strdup(forward_spec));
    if (ssh_port > 0 && ssh_port != 22) {
        g_ptr_array_add(argv, g_strdup("-p"));
        g_ptr_array_add(argv, g_strdup_printf("%d", ssh_port));
    }
    if (ssh_identity && ssh_identity[0] != '\0') {
        g_ptr_array_add(argv, g_strdup("-i"));
        g_ptr_array_add(argv, g_strdup(ssh_identity));
    }
    if (ssh_user && ssh_user[0] != '\0') {
        g_ptr_array_add(argv, g_strdup_printf("%s@%s", ssh_user, ssh_host));
    } else {
        g_ptr_array_add(argv, g_strdup(ssh_host));
    }
    g_ptr_array_add(argv, NULL);
    gchar **argv_s = (gchar **)g_ptr_array_free(argv, FALSE);

    g_autoptr(GSubprocessLauncher) launcher = g_subprocess_launcher_new(
        G_SUBPROCESS_FLAGS_STDOUT_SILENCE | G_SUBPROCESS_FLAGS_STDERR_PIPE);
    g_autoptr(GError) err = NULL;
    ctx->proc = g_subprocess_launcher_spawnv(launcher,
                                             (const gchar * const *)argv_s, &err);
    g_strfreev(argv_s);
    if (!ctx->proc) {
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("Could not run ssh"),
                g_strdup(err ? err->message : "spawn failed"));
        return;
    }

    ctx->forward_wait_started_us = g_get_monotonic_time();
    ctx->forward_poll_source_id =
        g_timeout_add(PROBE_FORWARD_POLL_MS, on_forward_poll, ctx);
    ctx->timeout_source_id = g_timeout_add(probe_ssh_timeout_ms(),
                                           on_ssh_timeout, ctx);
    g_subprocess_wait_async(ctx->proc, ctx->cancel, on_ssh_forward_wait, ctx);
}

void remote_probe_ssh_async(const gchar *ssh_user,
                            const gchar *ssh_host,
                            gint ssh_port,
                            const gchar *ssh_identity,
                            gint gateway_port,
                            GCancellable *cancel,
                            RemoteProbeCallback cb,
                            gpointer user_data) {
    ProbeCtx *ctx = g_new0(ProbeCtx, 1);
    ctx->cb = cb;
    ctx->user_data = user_data;
    ctx->cancel = cancel ? g_object_ref(cancel) : NULL;
    ctx->gateway_port = gateway_port;

    if (!ssh_host || ssh_host[0] == '\0' || ssh_host[0] == '-') {
        deliver(ctx, REMOTE_PROBE_FAILED,
                g_strdup("SSH target invalid"),
                g_strdup("SSH target host is empty or begins with '-'"));
        return;
    }

    if (gateway_port > 0) {
        spawn_ssh_forward_probe(ctx, ssh_user, ssh_host, ssh_port, ssh_identity);
    } else {
        spawn_ssh_echo_probe(ctx, ssh_user, ssh_host, ssh_port, ssh_identity);
    }
}
