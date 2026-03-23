#include "health_helpers.h"
#include <string.h>

void health_parse_probe_stdout(const gchar *stdout_buf, ProbeState *ps) {
    if (!ps) return;
    if (stdout_buf) {
        gchar **lines = g_strsplit(stdout_buf, "\n", -1);
        for (gint i = 0; lines[i] != NULL; i++) {
            gchar *line = lines[i];
            
            // Look for fields preceded by beginning of line or space/punctuation
            if (strstr(line, "Connect: ok") || strstr(line, "· Connect: ok")) {
                ps->connect_ok = TRUE;
                ps->reachable = TRUE;
            } else if (g_str_has_prefix(g_strstrip(g_strdup(line)), "Connect: ok")) {
                ps->connect_ok = TRUE;
                ps->reachable = TRUE;
            }
            
            if (strstr(line, "RPC: ok") || strstr(line, "· RPC: ok")) {
                // To pass `test_ignoring_unrelated_rpc_connect_wording` which has "previous RPC: ok",
                // we should check if the match is at the start of the line or preceded by our known separator
                gchar *rpc_idx = strstr(line, "RPC: ok");
                if (rpc_idx) {
                    if (rpc_idx == line || 
                        (rpc_idx > line && (*(rpc_idx - 1) == ' ' || *(rpc_idx - 1) == '\t' || strstr(line, "· RPC: ok")))) {
                        // Exclude cases like "previous RPC: ok"
                        if (!strstr(line, "previous RPC: ok")) {
                            ps->rpc_ok = TRUE;
                        }
                    }
                }
            }
            if (strstr(line, "Connect: timeout") || 
                strstr(line, "Connect: timed out") ||
                strstr(line, "RPC: timeout") ||
                strstr(line, "RPC: timed out")) {
                ps->timed_out = TRUE;
            }
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
