/*
 * remote_tunnel.c
 *
 * SSH control-tunnel supervisor for the OpenClaw Linux Companion App.
 *
 * ENGINEERING BOUNDARY — READ BEFORE MODIFYING
 *
 * This module supervises `/usr/bin/ssh` as a managed GSubprocess to
 * forward a remote gateway port to localhost (ssh -N -L <local>:
 * 127.0.0.1:<remote>). It is a deliberate, carefully isolated
 * subsystem. No other module in this companion should spawn, signal,
 * or parse ssh output; all remote-SSH concerns MUST go through the
 * public API in remote_tunnel.h.
 *
 * RATIONALE FOR OPENSSH-AS-SUBPROCESS (not libssh):
 *   1. Parity with the macOS companion (RemotePortTunnel +
 *      RemoteTunnelManager), which also supervises /usr/bin/ssh.
 *   2. Reuses the operator's ssh_config, ~/.ssh/known_hosts,
 *      ssh-agent, ProxyJump, and Kerberos support without re-
 *      implementing any of it.
 *   3. Isolates a crash-prone, latency-prone I/O boundary behind a
 *      process boundary: a companion crash does not corrupt the ssh
 *      session; an ssh crash does not corrupt the companion.
 *   4. Keeps the crypto stack (openssh) out of the companion's
 *      address space.
 *
 * FUTURE LIBSSH CONSIDERATION:
 *   If product needs emerge that this boundary makes expensive —
 *   e.g., in-process ControlMaster multiplexing, non-interactive key
 *   passphrase prompts with companion-managed storage, fine-grained
 *   per-tunnel telemetry beyond stderr scraping, or elimination of
 *   the /usr/bin/ssh dependency for sandboxed installs — replacing
 *   this module with libssh behind the same public API is a viable
 *   path. The public API is intentionally narrow for this reason.
 *
 * LIFECYCLE INVARIANTS:
 *   - Single tunnel at a time (control channel only).
 *   - All state machine transitions happen on the GLib main context.
 *   - ExitOnForwardFailure=yes is mandatory so bind failures surface
 *     as tunnel failures, not as silent partial connectivity.
 *   - SIGTERM-resistant ssh is escalated to SIGKILL after 3 s so
 *     shutdown and mode-switch make forward progress.
 *   - Stderr is drained line-by-line into oc_log; last line is kept
 *     in last_error for UI consumption.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "remote_tunnel.h"

#include <errno.h>
#include <gio/gio.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <signal.h>
#include <unistd.h>

#include "log.h"
#include "remote_port_check.h"
#include "remote_tunnel_command.h"

/* Grace period after spawn to detect immediate exit (matches macOS 150 ms). */
#define TUNNEL_SPAWN_GRACE_MS 250
#define TUNNEL_TERM_GRACE_MS  3000
#define TUNNEL_HEALTHY_RESET_S 30
/*
 * Grace period after SIGTERM to an adopted ssh pid before we escalate
 * to SIGKILL. Adopted processes are not owned by GSubprocess so we
 * cannot use g_subprocess_force_exit and we cannot wait_async on them;
 * instead we probe with kill(pid, 0) after the grace period and SIGKILL
 * if the process is still alive. Kept under one second so a mode-flip
 * can complete quickly even when the previous-generation ssh ignores
 * SIGTERM.
 */
#define TUNNEL_ADOPT_KILL_GRACE_MS 500

/* Backoff schedule (seconds) indexed by consecutive failure count. */
static const gint backoff_schedule[] = { 2, 5, 15, 30 };

typedef struct {
    gchar *ssh_user;
    gchar *ssh_host;
    gint ssh_port;
    gchar *ssh_identity;
    gint local_port;
    gint remote_port;
} TunnelSpec;

typedef struct {
    guint id;
    RemoteTunnelChangedFn cb;
    gpointer user_data;
} Subscriber;

static gboolean g_initialized = FALSE;
static TunnelSpec g_spec = {0};
static gboolean g_spec_set = FALSE;

static GSubprocess *g_proc = NULL;
static GCancellable *g_wait_cancel = NULL;
static GCancellable *g_stderr_cancel = NULL;
static guint g_grace_timer = 0;
static guint g_backoff_timer = 0;
static guint g_term_timer = 0;

/*
 * Pending SIGKILL escalation against an adopted ssh pid (see
 * TUNNEL_ADOPT_KILL_GRACE_MS). g_adopt_kill_pid is held while the
 * timer is scheduled so the timer callback can decide whether the
 * pid is still alive and needs SIGKILL.
 */
static guint g_adopt_kill_timer = 0;
static gint  g_adopt_kill_pid = 0;

static RemoteTunnelState g_state = { .kind = REMOTE_TUNNEL_IDLE };
static gchar *g_last_error_buf = NULL;   /* heap-owned backing for state.last_error */
static GArray *g_subs = NULL;

static gchar *g_ssh_binary_override = NULL;

static gchar *g_state_dir = NULL;

/*
 * When the supervisor adopted an existing ssh process from a previous
 * companion run, we do not own the GSubprocess and cannot use
 * g_subprocess_wait_async on it. We track the adopted pid here so we
 * can deliver SIGTERM during stop/cleanup. A non-zero g_adopted_pid
 * implies g_proc == NULL and g_state.kind == REMOTE_TUNNEL_READY.
 */
static gint g_adopted_pid = 0;

static void start_spawn(void);
static void schedule_backoff(void);
static void finish_cleanup_state(void);
static void record_remove(void);

static const gchar* ssh_binary(void) {
    if (g_ssh_binary_override) return g_ssh_binary_override;
    return "/usr/bin/ssh";
}

static void spec_clear(TunnelSpec *s) {
    g_clear_pointer(&s->ssh_user, g_free);
    g_clear_pointer(&s->ssh_host, g_free);
    g_clear_pointer(&s->ssh_identity, g_free);
    s->ssh_port = 22;
    s->local_port = 0;
    s->remote_port = 0;
}

static void spec_copy(TunnelSpec *dst,
                      const gchar *ssh_user,
                      const gchar *ssh_host,
                      gint ssh_port,
                      const gchar *ssh_identity,
                      gint local_port,
                      gint remote_port) {
    spec_clear(dst);
    dst->ssh_user = ssh_user ? g_strdup(ssh_user) : NULL;
    dst->ssh_host = ssh_host ? g_strdup(ssh_host) : NULL;
    dst->ssh_port = (ssh_port > 0) ? ssh_port : 22;
    dst->ssh_identity = ssh_identity ? g_strdup(ssh_identity) : NULL;
    dst->local_port = local_port;
    dst->remote_port = remote_port;
}

static gboolean spec_equal(const TunnelSpec *a, const TunnelSpec *b) {
    if (g_strcmp0(a->ssh_user, b->ssh_user) != 0) return FALSE;
    if (g_strcmp0(a->ssh_host, b->ssh_host) != 0) return FALSE;
    if (a->ssh_port != b->ssh_port) return FALSE;
    if (g_strcmp0(a->ssh_identity, b->ssh_identity) != 0) return FALSE;
    if (a->local_port != b->local_port) return FALSE;
    if (a->remote_port != b->remote_port) return FALSE;
    return TRUE;
}

static gchar* spec_signature(const TunnelSpec *s) {
    if (!s) return g_strdup("");
    return g_strdup_printf(
        "%s|%s|%d|%s|%d|%d",
        s->ssh_user ? s->ssh_user : "",
        s->ssh_host ? s->ssh_host : "",
        s->ssh_port,
        s->ssh_identity ? s->ssh_identity : "",
        s->local_port,
        s->remote_port);
}

/* ── Runtime record persistence ── */

static gchar* record_path(void) {
    if (!g_state_dir || g_state_dir[0] == '\0') return NULL;
    return g_build_filename(g_state_dir, "remote-tunnel.json", NULL);
}

static void record_remove(void) {
    g_autofree gchar *path = record_path();
    if (!path) return;
    if (g_unlink(path) != 0 && errno != ENOENT) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_REMOTE,
                     "remote_tunnel record_remove %s: %s", path, g_strerror(errno));
    }
}

static void record_save(const TunnelSpec *spec, gint pid) {
    g_autofree gchar *path = record_path();
    if (!path || !spec || pid <= 0) return;

    /* Ensure parent dir exists; ignore failures and log only. */
    g_autofree gchar *parent = g_path_get_dirname(path);
    if (parent && g_mkdir_with_parents(parent, 0700) != 0) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_REMOTE,
                     "remote_tunnel record_save mkdir(%s) failed: %s",
                     parent, g_strerror(errno));
    }

    g_autoptr(JsonBuilder) b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "pid");
    json_builder_add_int_value(b, pid);
    json_builder_set_member_name(b, "local_port");
    json_builder_add_int_value(b, spec->local_port);
    json_builder_set_member_name(b, "remote_port");
    json_builder_add_int_value(b, spec->remote_port);
    json_builder_set_member_name(b, "ssh_user");
    json_builder_add_string_value(b, spec->ssh_user ? spec->ssh_user : "");
    json_builder_set_member_name(b, "ssh_host");
    json_builder_add_string_value(b, spec->ssh_host ? spec->ssh_host : "");
    json_builder_set_member_name(b, "ssh_port");
    json_builder_add_int_value(b, spec->ssh_port);
    json_builder_set_member_name(b, "ssh_identity");
    json_builder_add_string_value(b, spec->ssh_identity ? spec->ssh_identity : "");
    g_autofree gchar *sig = spec_signature(spec);
    json_builder_set_member_name(b, "signature");
    json_builder_add_string_value(b, sig);
    json_builder_set_member_name(b, "started_at_unix");
    json_builder_add_int_value(b, (gint64)time(NULL));
    json_builder_end_object(b);

    g_autoptr(JsonGenerator) gen = json_generator_new();
    g_autoptr(JsonNode) root = json_builder_get_root(b);
    json_generator_set_root(gen, root);
    json_generator_set_pretty(gen, FALSE);
    g_autoptr(GError) err = NULL;
    if (!json_generator_to_file(gen, path, &err)) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_REMOTE,
                    "remote_tunnel record_save %s failed: %s",
                    path, err ? err->message : "?");
    }
}

/* Returned struct fields are heap-owned; caller frees via g_free / by hand. */
typedef struct {
    gint pid;
    gint local_port;
    gint remote_port;
    gchar *ssh_user;
    gchar *ssh_host;
    gint ssh_port;
    gchar *ssh_identity;
    gchar *signature;
    gint64 started_at_unix;
} RecordSnapshot;

static void record_snapshot_clear(RecordSnapshot *r) {
    if (!r) return;
    g_clear_pointer(&r->ssh_user, g_free);
    g_clear_pointer(&r->ssh_host, g_free);
    g_clear_pointer(&r->ssh_identity, g_free);
    g_clear_pointer(&r->signature, g_free);
    memset(r, 0, sizeof(*r));
}

static gboolean record_load(RecordSnapshot *out) {
    if (!out) return FALSE;
    memset(out, 0, sizeof(*out));
    g_autofree gchar *path = record_path();
    if (!path) return FALSE;
    if (!g_file_test(path, G_FILE_TEST_EXISTS)) return FALSE;

    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) err = NULL;
    if (!json_parser_load_from_file(parser, path, &err)) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_REMOTE,
                     "remote_tunnel record_load parse failed: %s",
                     err ? err->message : "?");
        return FALSE;
    }
    JsonNode *root = json_parser_get_root(parser);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) return FALSE;
    JsonObject *o = json_node_get_object(root);

    out->pid             = (gint)json_object_get_int_member_with_default(o, "pid", 0);
    out->local_port      = (gint)json_object_get_int_member_with_default(o, "local_port", 0);
    out->remote_port     = (gint)json_object_get_int_member_with_default(o, "remote_port", 0);
    out->ssh_port        = (gint)json_object_get_int_member_with_default(o, "ssh_port", 22);
    out->started_at_unix = json_object_get_int_member_with_default(o, "started_at_unix", 0);
    out->ssh_user        = g_strdup(json_object_get_string_member_with_default(o, "ssh_user", ""));
    out->ssh_host        = g_strdup(json_object_get_string_member_with_default(o, "ssh_host", ""));
    out->ssh_identity    = g_strdup(json_object_get_string_member_with_default(o, "ssh_identity", ""));
    out->signature       = g_strdup(json_object_get_string_member_with_default(o, "signature", ""));
    return TRUE;
}

static gboolean pid_is_alive(gint pid) {
    if (pid <= 1) return FALSE;
    if (kill((pid_t)pid, 0) == 0) return TRUE;
    return errno == EPERM;  /* still alive but owned by another uid */
}

static gboolean try_adopt(const TunnelSpec *requested) {
    if (!g_state_dir || !requested) return FALSE;
    RecordSnapshot rec;
    if (!record_load(&rec)) return FALSE;

    gboolean adopt = FALSE;
    g_autofree gchar *want_sig = spec_signature(requested);
    if (rec.pid > 1 &&
        rec.local_port == requested->local_port &&
        g_strcmp0(rec.signature, want_sig) == 0 &&
        pid_is_alive(rec.pid) &&
        remote_port_check_loopback_listening(rec.local_port, 250)) {
        adopt = TRUE;
    }

    if (!adopt) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_REMOTE,
                     "remote_tunnel adoption rejected (pid=%d sig_match=%d alive=%d listening=%d)",
                     rec.pid,
                     g_strcmp0(rec.signature, want_sig) == 0,
                     pid_is_alive(rec.pid),
                     remote_port_check_loopback_listening(rec.local_port, 0));
        record_remove();
        record_snapshot_clear(&rec);
        return FALSE;
    }

    OC_LOG_INFO(OPENCLAW_LOG_CAT_REMOTE,
                "remote_tunnel adopted existing ssh pid=%d local_port=%d",
                rec.pid, rec.local_port);
    g_adopted_pid = rec.pid;
    g_state.pid = rec.pid;
    g_state.local_port = rec.local_port;
    g_state.ready_since_us = g_get_monotonic_time();
    g_state.restart_count = 0;
    record_snapshot_clear(&rec);
    return TRUE;
}

static void notify_subscribers(void) {
    if (!g_subs) return;
    guint n = g_subs->len;
    Subscriber *copy = g_new(Subscriber, n);
    memcpy(copy, g_subs->data, sizeof(Subscriber) * n);
    for (guint i = 0; i < n; i++) {
        if (copy[i].cb) copy[i].cb(copy[i].user_data);
    }
    g_free(copy);
}

static void set_last_error(const gchar *msg) {
    g_clear_pointer(&g_last_error_buf, g_free);
    if (msg && msg[0] != '\0') {
        /* Keep a single-line compact message for the UI. */
        gchar *copy = g_strdup(msg);
        for (gchar *p = copy; *p; p++) {
            if (*p == '\n' || *p == '\r') { *p = '\0'; break; }
        }
        g_last_error_buf = copy;
    }
    g_state.last_error = g_last_error_buf;
}

static void publish(void) {
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_REMOTE,
                 "remote_tunnel state=%s pid=%d local_port=%d restart=%d last_error=%s",
                 remote_tunnel_state_to_string(g_state.kind),
                 g_state.pid, g_state.local_port, g_state.restart_count,
                 g_state.last_error ? g_state.last_error : "(none)");
    notify_subscribers();
}

static void transition(RemoteTunnelStateKind kind) {
    g_state.kind = kind;
    publish();
}

static void clear_timers(void) {
    if (g_grace_timer) { g_source_remove(g_grace_timer); g_grace_timer = 0; }
    if (g_backoff_timer) { g_source_remove(g_backoff_timer); g_backoff_timer = 0; }
    if (g_term_timer) { g_source_remove(g_term_timer); g_term_timer = 0; }
}

static void drain_stderr_line_cb(GObject *source, GAsyncResult *result, gpointer user_data);

static void schedule_stderr_read(GDataInputStream *stream) {
    if (!stream) return;
    if (!g_stderr_cancel) g_stderr_cancel = g_cancellable_new();
    g_data_input_stream_read_line_async(stream, G_PRIORITY_DEFAULT,
                                        g_stderr_cancel,
                                        drain_stderr_line_cb, stream);
}

static void drain_stderr_line_cb(GObject *source, GAsyncResult *result, gpointer user_data) {
    GDataInputStream *stream = G_DATA_INPUT_STREAM(source);
    gsize len = 0;
    g_autoptr(GError) err = NULL;
    g_autofree gchar *line = g_data_input_stream_read_line_finish_utf8(stream, result, &len, &err);
    if (err) {
        if (!g_error_matches(err, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_REMOTE,
                         "remote_tunnel stderr read error: %s", err->message);
        }
        return;
    }
    if (!line) {
        /* EOF */
        return;
    }
    if (line[0] != '\0') {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_REMOTE, "ssh: %s", line);
        set_last_error(line);
        publish();
    }
    schedule_stderr_read(stream);
    (void)user_data;
}

static void begin_stderr_drain(void) {
    if (!g_proc) return;
    GInputStream *raw = g_subprocess_get_stderr_pipe(g_proc);
    if (!raw) return;
    GDataInputStream *data = g_data_input_stream_new(raw);
    g_data_input_stream_set_newline_type(data, G_DATA_STREAM_NEWLINE_TYPE_ANY);
    schedule_stderr_read(data);
    /* Attach to keep alive until shutdown closes the stream. */
    g_object_set_data_full(G_OBJECT(g_proc), "tunnel-stderr-stream",
                           data, g_object_unref);
}

static void stop_stderr_drain(void) {
    if (g_stderr_cancel) {
        g_cancellable_cancel(g_stderr_cancel);
        g_clear_object(&g_stderr_cancel);
    }
    if (g_proc) {
        GObject *existing = g_object_get_data(G_OBJECT(g_proc), "tunnel-stderr-stream");
        if (existing) {
            g_object_set_data(G_OBJECT(g_proc), "tunnel-stderr-stream", NULL);
        }
    }
}

static void on_process_wait(GObject *source, GAsyncResult *result, gpointer user_data) {
    (void)user_data;
    g_autoptr(GError) err = NULL;
    gboolean ok = g_subprocess_wait_finish(G_SUBPROCESS(source), result, &err);
    if (err && g_error_matches(err, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
        return;
    }
    if (!ok && err) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_REMOTE,
                    "remote_tunnel wait failed: %s", err->message);
    }
    /* Process has exited. Capture stderr snapshot before tearing it down. */
    gint exit_status = -1;
    gboolean exited_normally = FALSE;
    if (g_proc && G_SUBPROCESS(source) == g_proc) {
        if (g_subprocess_get_if_exited(g_proc)) {
            exited_normally = TRUE;
            exit_status = g_subprocess_get_exit_status(g_proc);
        } else if (g_subprocess_get_if_signaled(g_proc)) {
            exit_status = g_subprocess_get_term_sig(g_proc);
        }
    }

    OC_LOG_INFO(OPENCLAW_LOG_CAT_REMOTE,
                "remote_tunnel ssh exited status=%d normal=%d (state=%s)",
                exit_status, exited_normally,
                remote_tunnel_state_to_string(g_state.kind));

    stop_stderr_drain();
    finish_cleanup_state();
    /* Process is gone — the runtime record is now stale. */
    record_remove();

    /* Decide next action based on the state we were in. */
    RemoteTunnelStateKind prev = g_state.kind;
    if (prev == REMOTE_TUNNEL_STOPPING || prev == REMOTE_TUNNEL_IDLE) {
        /* Clean stop requested; no restart. */
        g_state.pid = 0;
        g_state.local_port = 0;
        g_state.ready_since_us = 0;
        transition(REMOTE_TUNNEL_IDLE);
        return;
    }

    /* Unexpected exit. Update failure counters and schedule backoff if
     * the tunnel was healthy for long enough to reset the counter. */
    gint64 now = g_get_monotonic_time();
    if (prev == REMOTE_TUNNEL_READY &&
        g_state.ready_since_us > 0 &&
        (now - g_state.ready_since_us) >= ((gint64)TUNNEL_HEALTHY_RESET_S * G_USEC_PER_SEC)) {
        g_state.restart_count = 0;
    } else {
        g_state.restart_count++;
    }
    g_state.pid = 0;
    g_state.local_port = 0;
    g_state.ready_since_us = 0;

    if (!g_spec_set) {
        transition(REMOTE_TUNNEL_IDLE);
        return;
    }

    set_last_error(g_state.last_error ? g_state.last_error : "ssh exited");
    schedule_backoff();
}

static void launch_subprocess(void) {
    RemoteTunnelCommandSpec cmd_spec = {
        .ssh_user = g_spec.ssh_user,
        .ssh_host = g_spec.ssh_host,
        .ssh_port = g_spec.ssh_port,
        .ssh_identity = g_spec.ssh_identity,
        .local_port = g_spec.local_port,
        .remote_port = g_spec.remote_port,
    };
    g_auto(GStrv) argv = remote_tunnel_command_build(&cmd_spec);
    if (!argv) {
        set_last_error("invalid tunnel spec");
        transition(REMOTE_TUNNEL_FAILED);
        return;
    }

    /* Allow test override of the ssh binary — replaces argv[0]. */
    g_free(argv[0]);
    argv[0] = g_strdup(ssh_binary());

    g_auto(GStrv) dbg = g_strdupv(argv);
    g_autofree gchar *cmdline = remote_tunnel_command_to_string(dbg);
    OC_LOG_INFO(OPENCLAW_LOG_CAT_REMOTE, "remote_tunnel spawn: %s", cmdline);

    g_autoptr(GSubprocessLauncher) launcher = g_subprocess_launcher_new(
        G_SUBPROCESS_FLAGS_STDIN_PIPE | G_SUBPROCESS_FLAGS_STDERR_PIPE);
    g_autoptr(GError) err = NULL;
    g_proc = g_subprocess_launcher_spawnv(launcher, (const gchar * const *)argv, &err);
    if (!g_proc) {
        set_last_error(err ? err->message : "ssh spawn failed");
        transition(REMOTE_TUNNEL_FAILED);
        schedule_backoff();
        return;
    }

    const gchar *ident = g_subprocess_get_identifier(g_proc);
    g_state.pid = ident ? atoi(ident) : 0;
    g_state.local_port = g_spec.local_port;

    g_wait_cancel = g_cancellable_new();
    g_subprocess_wait_async(g_proc, g_wait_cancel, on_process_wait, NULL);
    begin_stderr_drain();
}

static gboolean on_spawn_grace_timeout(gpointer user_data) {
    (void)user_data;
    g_grace_timer = 0;
    if (!g_proc) return G_SOURCE_REMOVE;
    if (g_state.kind != REMOTE_TUNNEL_STARTING) return G_SOURCE_REMOVE;

    /* If the subprocess is still alive after the grace window, we
     * consider the forward established. ExitOnForwardFailure=yes
     * guarantees ssh has either exited (→ wait callback) or has the
     * forward bound. */
    gint64 now = g_get_monotonic_time();
    g_state.ready_since_us = now;
    /* Persist the runtime record so a freshly-restarted companion can
     * adopt this ssh process instead of redundantly spawning another. */
    record_save(&g_spec, g_state.pid);
    transition(REMOTE_TUNNEL_READY);
    return G_SOURCE_REMOVE;
}

static void start_spawn(void) {
    clear_timers();
    g_state.pid = 0;
    g_state.local_port = g_spec.local_port;

    /*
     * Pre-flight port check. ssh -L would normally surface this as
     * "bind: Address already in use" via stderr after spawn, but we
     * can give the operator a clearer, faster error by checking
     * loopback bindability up front. The check is racy by nature but
     * eliminates the common failure mode (companion restart while a
     * stale ssh from the previous run still holds the port).
     */
    if (!remote_port_check_loopback_free(g_spec.local_port)) {
        g_autofree gchar *msg = g_strdup_printf(
            "local port %d is busy (loopback bind failed)",
            g_spec.local_port);
        set_last_error(msg);
        g_state.restart_count++;
        transition(REMOTE_TUNNEL_FAILED);
        schedule_backoff();
        return;
    }

    transition(REMOTE_TUNNEL_STARTING);
    launch_subprocess();
    if (g_state.kind == REMOTE_TUNNEL_STARTING) {
        g_grace_timer = g_timeout_add(TUNNEL_SPAWN_GRACE_MS,
                                      on_spawn_grace_timeout, NULL);
    }
}

static gboolean on_backoff_timeout(gpointer user_data) {
    (void)user_data;
    g_backoff_timer = 0;
    if (!g_spec_set) {
        transition(REMOTE_TUNNEL_IDLE);
        return G_SOURCE_REMOVE;
    }
    start_spawn();
    return G_SOURCE_REMOVE;
}

static void schedule_backoff(void) {
    gint idx = g_state.restart_count - 1;
    if (idx < 0) idx = 0;
    gint max = (gint)(sizeof(backoff_schedule) / sizeof(backoff_schedule[0])) - 1;
    if (idx > max) idx = max;
    gint seconds = backoff_schedule[idx];
    g_state.backoff_seconds = seconds;
    transition(REMOTE_TUNNEL_BACKOFF);
    g_backoff_timer = g_timeout_add_seconds(seconds, on_backoff_timeout, NULL);
}

static void send_terminate(void) {
    if (!g_proc) return;
    g_subprocess_send_signal(g_proc, SIGTERM);
}

static gboolean on_term_timeout(gpointer user_data) {
    (void)user_data;
    g_term_timer = 0;
    if (g_proc && g_subprocess_get_if_exited(g_proc) == FALSE) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_REMOTE,
                    "remote_tunnel SIGTERM timeout — escalating to SIGKILL");
        g_subprocess_force_exit(g_proc);
    }
    return G_SOURCE_REMOVE;
}

/*
 * Adopt-kill grace handler: called TUNNEL_ADOPT_KILL_GRACE_MS after we
 * delivered SIGTERM to an adopted ssh pid. If the pid is still alive
 * (kill(pid, 0) returns 0), escalate to SIGKILL so a TERM-resistant
 * adopted process cannot pin us in REMOTE on a mode flip.
 */
static gint  g_adopt_kill_grace_ms_override = 0;

static gint adopt_kill_grace_ms(void) {
    return g_adopt_kill_grace_ms_override > 0
        ? g_adopt_kill_grace_ms_override
        : TUNNEL_ADOPT_KILL_GRACE_MS;
}

static gboolean on_adopt_kill_grace(gpointer user_data) {
    (void)user_data;
    g_adopt_kill_timer = 0;
    if (g_adopt_kill_pid > 1) {
        if (kill((pid_t)g_adopt_kill_pid, 0) == 0) {
            OC_LOG_WARN(OPENCLAW_LOG_CAT_REMOTE,
                        "remote_tunnel adopted ssh pid=%d ignored SIGTERM — "
                        "escalating to SIGKILL",
                        g_adopt_kill_pid);
            kill((pid_t)g_adopt_kill_pid, SIGKILL);
        }
        g_adopt_kill_pid = 0;
    }
    return G_SOURCE_REMOVE;
}

/*
 * Send SIGTERM to an adopted ssh pid and arm a SIGKILL escalation
 * timer. Caller is responsible for clearing g_adopted_pid before/after
 * calling this; we capture the pid by value so the timer is robust
 * to subsequent state changes.
 */
static void send_terminate_adopted(gint pid) {
    if (pid <= 1) return;
    kill((pid_t)pid, SIGTERM);
    /*
     * If we already have a pending escalation against a different pid
     * (e.g. rapid stop-then-stop), cancel it; the new pid takes over.
     */
    if (g_adopt_kill_timer) {
        g_source_remove(g_adopt_kill_timer);
        g_adopt_kill_timer = 0;
    }
    g_adopt_kill_pid = pid;
    g_adopt_kill_timer = g_timeout_add(adopt_kill_grace_ms(),
                                       on_adopt_kill_grace, NULL);
}

static void finish_cleanup_state(void) {
    clear_timers();
    if (g_wait_cancel) {
        g_cancellable_cancel(g_wait_cancel);
        g_clear_object(&g_wait_cancel);
    }
    stop_stderr_drain();
    g_clear_object(&g_proc);
}

/* ── Public API ── */

void remote_tunnel_init(void) {
    if (g_initialized) return;
    g_initialized = TRUE;
    g_subs = g_array_new(FALSE, FALSE, sizeof(Subscriber));
    memset(&g_state, 0, sizeof(g_state));
    g_state.kind = REMOTE_TUNNEL_IDLE;
    spec_clear(&g_spec);
}

void remote_tunnel_shutdown(void) {
    if (!g_initialized) return;
    g_initialized = FALSE;
    remote_tunnel_force_cleanup();
    spec_clear(&g_spec);
    g_spec_set = FALSE;
    g_clear_pointer(&g_last_error_buf, g_free);
    if (g_subs) {
        g_array_free(g_subs, TRUE);
        g_subs = NULL;
    }
}

void remote_tunnel_force_cleanup(void) {
    clear_timers();
    /*
     * Cancel any pending adopt-kill escalation. Critically, we must
     * actually deliver the SIGKILL we previously promised before
     * dropping the timer — otherwise a SIGTERM-resistant adopted ssh
     * (whose graceful TERM was scheduled by remote_tunnel_stop) is
     * left alive and will keep the loopback forward port held.
     *
     * remote_tunnel_stop() clears g_adopted_pid before scheduling the
     * timer, so the surviving pid lives on g_adopt_kill_pid. The block
     * below for g_adopted_pid covers the orthogonal "force_cleanup
     * called without a prior stop" path.
     */
    if (g_adopt_kill_pid > 1) {
        /* No need to probe with kill(pid, 0) first: SIGKILL on a
         * non-existent pid simply returns ESRCH and is harmless. */
        kill((pid_t)g_adopt_kill_pid, SIGKILL);
    }
    if (g_adopt_kill_timer) {
        g_source_remove(g_adopt_kill_timer);
        g_adopt_kill_timer = 0;
    }
    g_adopt_kill_pid = 0;

    if (g_proc) {
        g_subprocess_force_exit(g_proc);
    }
    if (g_adopted_pid > 1) {
        /*
         * force_cleanup is the hard path (shutdown, mode-flip with
         * race). Send SIGTERM then SIGKILL immediately so we don't
         * leave the loopback port held by a stale ssh.
         */
        kill((pid_t)g_adopted_pid, SIGTERM);
        kill((pid_t)g_adopted_pid, SIGKILL);
        g_adopted_pid = 0;
    }
    finish_cleanup_state();
    record_remove();
    memset(&g_state, 0, sizeof(g_state));
    g_state.kind = REMOTE_TUNNEL_IDLE;
    g_state.last_error = g_last_error_buf;
    publish();
}

void remote_tunnel_ensure(const gchar *ssh_user,
                          const gchar *ssh_host,
                          gint         ssh_port,
                          const gchar *ssh_identity,
                          gint         local_port,
                          gint         remote_port) {
    if (!g_initialized) remote_tunnel_init();
    if (!ssh_host || ssh_host[0] == '\0' ||
        local_port <= 0 || remote_port <= 0) {
        set_last_error("invalid ensure request");
        transition(REMOTE_TUNNEL_FAILED);
        return;
    }

    TunnelSpec requested = {0};
    spec_copy(&requested,
              ssh_user, ssh_host, ssh_port, ssh_identity,
              local_port, remote_port);

    gboolean same_spec = g_spec_set && spec_equal(&g_spec, &requested);
    if (same_spec && g_state.kind == REMOTE_TUNNEL_READY) {
        /* Already running with the same spec. */
        spec_clear(&requested);
        return;
    }
    if (same_spec &&
        (g_state.kind == REMOTE_TUNNEL_STARTING ||
         g_state.kind == REMOTE_TUNNEL_BACKOFF)) {
        /* Already progressing toward the desired spec. */
        spec_clear(&requested);
        return;
    }

    /* New or changed spec — stop whatever is running (if anything) and restart. */
    if (g_state.kind != REMOTE_TUNNEL_IDLE) {
        remote_tunnel_force_cleanup();
    }
    spec_clear(&g_spec);
    g_spec = requested; /* ownership moves */
    g_spec_set = TRUE;
    memset(&requested, 0, sizeof(requested));

    g_state.restart_count = 0;
    g_state.local_port = local_port;

    /*
     * Adoption: if a previous companion run left a still-healthy ssh
     * with the exact same spec listening on the same loopback port,
     * skip spawn and surface it as READY immediately. We do not own
     * the GSubprocess in this case (try_adopt sets g_adopted_pid).
     */
    if (try_adopt(&g_spec)) {
        transition(REMOTE_TUNNEL_READY);
        return;
    }

    start_spawn();
}

void remote_tunnel_stop(void) {
    if (!g_initialized) return;
    g_spec_set = FALSE;
    spec_clear(&g_spec);
    if (g_state.kind == REMOTE_TUNNEL_IDLE) return;

    if (g_proc && g_state.kind != REMOTE_TUNNEL_STOPPING) {
        transition(REMOTE_TUNNEL_STOPPING);
        send_terminate();
        g_term_timer = g_timeout_add(TUNNEL_TERM_GRACE_MS, on_term_timeout, NULL);
        return;
    }

    /*
     * Adopted process: signal directly via pid; we don't own a
     * GSubprocess. Send SIGTERM and arm a SIGKILL escalation timer
     * so a TERM-resistant adopted ssh cannot keep the tunnel pinned
     * across a mode flip.
     */
    if (g_adopted_pid > 1 && g_state.kind == REMOTE_TUNNEL_READY) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_REMOTE,
                    "remote_tunnel stopping adopted ssh pid=%d", g_adopted_pid);
        gint adopted_pid = g_adopted_pid;
        g_adopted_pid = 0;
        send_terminate_adopted(adopted_pid);
    }

    /* Not running as a process — may be in BACKOFF; just cancel timers. */
    clear_timers();
    finish_cleanup_state();
    record_remove();
    memset(&g_state, 0, sizeof(g_state));
    g_state.kind = REMOTE_TUNNEL_IDLE;
    g_state.last_error = g_last_error_buf;
    publish();
}

const RemoteTunnelState* remote_tunnel_get_state(void) {
    if (!g_initialized) remote_tunnel_init();
    return &g_state;
}

guint remote_tunnel_subscribe(RemoteTunnelChangedFn cb, gpointer user_data) {
    if (!g_initialized) remote_tunnel_init();
    if (!cb) return 0;
    static guint next_id = 1;
    Subscriber s = { .id = next_id++, .cb = cb, .user_data = user_data };
    g_array_append_val(g_subs, s);
    return s.id;
}

void remote_tunnel_unsubscribe(guint subscription_id) {
    if (!g_initialized || !g_subs || subscription_id == 0) return;
    for (guint i = 0; i < g_subs->len; i++) {
        Subscriber *s = &g_array_index(g_subs, Subscriber, i);
        if (s->id == subscription_id) {
            g_array_remove_index(g_subs, i);
            return;
        }
    }
}

void remote_tunnel_set_state_dir(const gchar *dir) {
    g_clear_pointer(&g_state_dir, g_free);
    if (dir && dir[0] != '\0') g_state_dir = g_strdup(dir);
}

void remote_tunnel_test_set_ssh_binary(const gchar *path) {
    g_clear_pointer(&g_ssh_binary_override, g_free);
    if (path) g_ssh_binary_override = g_strdup(path);
}

void remote_tunnel_test_reset(void) {
    remote_tunnel_shutdown();
    g_clear_pointer(&g_ssh_binary_override, g_free);
    g_clear_pointer(&g_state_dir, g_free);
    g_adopted_pid = 0;
    if (g_adopt_kill_timer) {
        g_source_remove(g_adopt_kill_timer);
        g_adopt_kill_timer = 0;
    }
    g_adopt_kill_pid = 0;
    g_adopt_kill_grace_ms_override = 0;
}

void remote_tunnel_test_set_adopt_kill_grace_ms(gint ms) {
    g_adopt_kill_grace_ms_override = (ms > 0) ? ms : 0;
}

void remote_tunnel_test_install_adopted(gint pid,
                                        const gchar *ssh_user,
                                        const gchar *ssh_host,
                                        gint ssh_port,
                                        const gchar *ssh_identity,
                                        gint local_port,
                                        gint remote_port) {
    if (!g_initialized) remote_tunnel_init();
    spec_clear(&g_spec);
    spec_copy(&g_spec, ssh_user, ssh_host, ssh_port, ssh_identity,
              local_port, remote_port);
    g_spec_set = TRUE;
    g_adopted_pid = pid;
    memset(&g_state, 0, sizeof(g_state));
    g_state.kind = REMOTE_TUNNEL_READY;
    g_state.local_port = local_port;
    g_state.pid = pid;
    g_state.ready_since_us = g_get_monotonic_time();
}

const gchar* remote_tunnel_state_to_string(RemoteTunnelStateKind kind) {
    switch (kind) {
    case REMOTE_TUNNEL_IDLE:      return "idle";
    case REMOTE_TUNNEL_STARTING:  return "starting";
    case REMOTE_TUNNEL_READY:     return "ready";
    case REMOTE_TUNNEL_BACKOFF:   return "backoff";
    case REMOTE_TUNNEL_FAILED:    return "failed";
    case REMOTE_TUNNEL_STOPPING:  return "stopping";
    default:                      return "unknown";
    }
}
