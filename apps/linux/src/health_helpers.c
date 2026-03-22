#include "health_helpers.h"
#include <string.h>

void health_parse_probe_stdout(const gchar *stdout_buf, ProbeState *ps) {
    if (!ps) return;
    if (stdout_buf) {
        gchar **lines = g_strsplit(stdout_buf, "\n", -1);
        for (gint i = 0; lines[i] != NULL; i++) {
            gchar *line = lines[i];
            gchar *trimmed = g_strstrip(g_strdup(line));
            
            if (g_str_has_prefix(trimmed, "Connect:")) {
                if (g_str_has_prefix(trimmed, "Connect: ok")) {
                    ps->connect_ok = TRUE;
                    ps->reachable = TRUE;
                }
            }
            if (g_str_has_prefix(trimmed, "RPC: ok")) {
                ps->rpc_ok = TRUE;
            }
            if (g_str_has_prefix(trimmed, "Connect: timeout") || 
                g_str_has_prefix(trimmed, "Connect: timed out") ||
                g_str_has_prefix(trimmed, "RPC: timeout") ||
                g_str_has_prefix(trimmed, "RPC: timed out")) {
                ps->timed_out = TRUE;
            }
            g_free(trimmed);
        }
        g_strfreev(lines);
        
        // Synthesize summary strings based on the combination of connectivity booleans
        if (ps->reachable && ps->rpc_ok) {
            ps->summary = g_strdup("Fully reachable");
        } else if (ps->connect_ok && ps->timed_out) {
            ps->summary = g_strdup("Connect OK, but RPC timed out");
        } else if (!ps->reachable) {
            ps->summary = g_strdup("Not reachable");
        } else {
            ps->summary = g_strdup("Unknown or mixed probe result");
        }
    } else {
        ps->summary = g_strdup("No output from probe");
    }
}
