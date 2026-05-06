/*
 * session_filter.c
 * Description: Session filtering helpers for chat session dropdown choices.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "session_filter.h"

#include <string.h>

void session_choice_free(SessionChoice *choice) {
    if (!choice) return;
    g_free(choice->key);
    g_free(choice->label);
    g_free(choice);
}

gboolean session_filter_is_system_noise(const gchar *key) {
    if (!key || key[0] == '\0') return TRUE;
    if (g_str_has_suffix(key, ":heartbeat")) return TRUE;
    if (strstr(key, ":run:") != NULL) return TRUE;
    return FALSE;
}

static gchar* session_choice_label_for(const gchar *agent_id, const GatewaySession *s) {
    if (s->display_name && s->display_name[0] != '\0') {
        return g_strdup(s->display_name);
    }

    if (s->subject && s->subject[0] != '\0') {
        return g_strdup(s->subject);
    }

    if (s->key && agent_id && agent_id[0] != '\0') {
        g_autofree gchar *prefix = g_strdup_printf("agent:%s:", agent_id);
        if (g_str_has_prefix(s->key, prefix)) {
            return g_strdup(s->key + strlen(prefix));
        }
    }

    return g_strdup(s->key ? s->key : "(unknown)");
}

static gboolean session_key_matches_agent(const gchar *agent_id, const gchar *key) {
    if (!agent_id || !key) return FALSE;
    g_autofree gchar *prefix = g_strdup_printf("agent:%s:", agent_id);
    return g_str_has_prefix(key, prefix);
}

GPtrArray* session_filter_build_choices(const gchar *agent_id,
                                        const GatewaySession *sessions,
                                        gint n_sessions) {
    GPtrArray *out = g_ptr_array_new_with_free_func((GDestroyNotify)session_choice_free);
    if (!agent_id || agent_id[0] == '\0') {
        return out;
    }

    for (gint i = 0; i < n_sessions; i++) {
        const GatewaySession *s = &sessions[i];
        if (!s->key || s->key[0] == '\0') {
            continue;
        }
        if (!session_key_matches_agent(agent_id, s->key)) {
            continue;
        }
        if (session_filter_is_system_noise(s->key)) {
            continue;
        }

        SessionChoice *choice = g_new0(SessionChoice, 1);
        choice->key = g_strdup(s->key);
        choice->label = session_choice_label_for(agent_id, s);
        g_ptr_array_add(out, choice);
    }

    /*
     * Canonical default session key across core, web, TUI, and tests is
     * `agent:<agentId>:main` (see `resolveMainSessionKey()` and the
     * session-key routing tests). Using `agent:<agentId>:default` as we
     * did before silently created a throwaway session key the server
     * had never heard of — every chat.send bootstrapped a fresh
     * conversation and every chat.history returned empty, which made
     * the bot appear to loop on its first-turn greeting because each
     * user turn was the first turn as far as the gateway was
     * concerned. Keep this constant aligned with core's
     * `resolveMainSessionKey`.
     */
    g_autofree gchar *default_key = g_strdup_printf("agent:%s:main", agent_id);
    gboolean has_default = FALSE;
    for (guint i = 0; i < out->len; i++) {
        SessionChoice *choice = g_ptr_array_index(out, i);
        if (g_strcmp0(choice->key, default_key) == 0) {
            has_default = TRUE;
            break;
        }
    }

    if (!has_default) {
        SessionChoice *choice = g_new0(SessionChoice, 1);
        choice->key = g_strdup(default_key);
        /*
         * Human-readable fallback label for the synthesized main-session
         * entry. Kept deliberately short; the canonical name is shown in
         * the dropdown in tandem with the agent identity.
         */
        choice->label = g_strdup("main");
        g_ptr_array_add(out, choice);
    }

    return out;
}
