/*
 * session_filter.h
 * Description: Public declarations for session filtering and choice building.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>
#include "gateway_data.h"

typedef struct {
    gchar *key;
    gchar *label;
} SessionChoice;

gboolean session_filter_is_system_noise(const gchar *key);

GPtrArray* session_filter_build_choices(const gchar *agent_id,
                                        const GatewaySession *sessions,
                                        gint n_sessions);

void session_choice_free(SessionChoice *choice);
