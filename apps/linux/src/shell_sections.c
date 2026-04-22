/*
 * shell_sections.c
 *
 * Shell section registry for the OpenClaw Linux Companion App.
 *
 * Centralizes section metadata and controller lookup so the shell host can
 * build navigation and dispatch lifecycle operations without owning any
 * extracted section implementation details.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "shell_sections.h"

#include "section_agents.h"
#include "section_about.h"
#include "section_channels.h"
#include "section_config.h"
#include "section_control_room.h"
#include "section_cron.h"
#include "section_dashboard.h"
#include "section_debug.h"
#include "section_diagnostics.h"
#include "section_environment.h"
#include "section_general.h"
#include "section_instances.h"
#include "section_logs.h"
#include "section_sessions.h"
#include "section_skills.h"
#include "section_usage.h"
#include "section_workflows.h"

static const ShellSectionMeta section_meta[SECTION_COUNT] = {
    [SECTION_DASHBOARD]    = { "dashboard",    "Dashboard",    "computer-symbolic" },
    [SECTION_CHAT]         = { "chat",         "Chat",         "chat-bubbles-symbolic" },
    [SECTION_AGENTS]       = { "agents",       "Agents",       "avatar-default-symbolic" },
    [SECTION_USAGE]        = { "usage",        "Usage",        "view-statistics-symbolic" },
    [SECTION_GENERAL]      = { "general",      "General",      "preferences-system-symbolic" },
    [SECTION_CONFIG]       = { "config",       "Config",       "document-properties-symbolic" },
    [SECTION_CHANNELS]     = { "channels",     "Channels",     "mail-send-symbolic" },
    [SECTION_SKILLS]       = { "skills",       "Skills",       "applications-science-symbolic" },
    [SECTION_WORKFLOWS]    = { "workflows",    "Workflows",    "view-list-bullet-symbolic" },
    [SECTION_CONTROL_ROOM] = { "control-room", "Control Room", "applications-system-symbolic" },
    [SECTION_ENVIRONMENT]  = { "environment",  "Environment",  "system-run-symbolic" },
    [SECTION_DIAGNOSTICS]  = { "diagnostics",  "Diagnostics",  "utilities-system-monitor-symbolic" },
    [SECTION_LOGS]         = { "logs",         "Logs",         "text-x-log-symbolic" },
    [SECTION_ABOUT]        = { "about",        "About",        "help-about-symbolic" },
    [SECTION_INSTANCES]    = { "instances",    "Instances",    "network-server-symbolic" },
    [SECTION_DEBUG]        = { "debug",        "Debug",        "emblem-system-symbolic" },
    [SECTION_SESSIONS]     = { "sessions",     "Sessions",     "view-list-symbolic" },
    [SECTION_CRON]         = { "cron",         "Cron",         "alarm-symbolic" },
};

static const ShellSectionDisplayEntry section_display_order[] = {
    { SECTION_DASHBOARD,    SHELL_SECTION_GROUP_PARITY },
    { SECTION_GENERAL,      SHELL_SECTION_GROUP_PARITY },
    { SECTION_CHANNELS,     SHELL_SECTION_GROUP_PARITY },
    { SECTION_CONFIG,       SHELL_SECTION_GROUP_PARITY },
    { SECTION_INSTANCES,    SHELL_SECTION_GROUP_PARITY },
    { SECTION_SESSIONS,     SHELL_SECTION_GROUP_PARITY },
    { SECTION_CRON,         SHELL_SECTION_GROUP_PARITY },
    { SECTION_SKILLS,       SHELL_SECTION_GROUP_PARITY },
    { SECTION_ABOUT,        SHELL_SECTION_GROUP_PARITY },
    { SECTION_AGENTS,       SHELL_SECTION_GROUP_EXTRAS },
    { SECTION_USAGE,        SHELL_SECTION_GROUP_EXTRAS },
    { SECTION_WORKFLOWS,    SHELL_SECTION_GROUP_EXTRAS },
    { SECTION_CONTROL_ROOM, SHELL_SECTION_GROUP_EXTRAS },
    { SECTION_ENVIRONMENT,  SHELL_SECTION_GROUP_EXTRAS },
    { SECTION_DIAGNOSTICS,  SHELL_SECTION_GROUP_EXTRAS },
    { SECTION_LOGS,         SHELL_SECTION_GROUP_EXTRAS },
    { SECTION_DEBUG,        SHELL_SECTION_GROUP_EXTRAS },
};

gboolean shell_sections_is_embedded(AppSection section) {
    if (section < 0 || section >= SECTION_COUNT) {
        return FALSE;
    }

    return section != SECTION_CHAT;
}

const ShellSectionMeta* shell_sections_meta(AppSection section) {
    if (section < 0 || section >= SECTION_COUNT) {
        return NULL;
    }

    return &section_meta[section];
}

gsize shell_sections_display_count(void) {
    return G_N_ELEMENTS(section_display_order);
}

const ShellSectionDisplayEntry* shell_sections_display_at(gsize index) {
    if (index >= G_N_ELEMENTS(section_display_order)) {
        return NULL;
    }

    return &section_display_order[index];
}

gboolean shell_sections_debug_pane_enabled(void) {
    const gchar *value = g_getenv("OPENCLAW_DEBUG_PANE");

    if (!value || value[0] == '\0') {
        return FALSE;
    }

    return g_ascii_strcasecmp(value, "1") == 0
        || g_ascii_strcasecmp(value, "true") == 0
        || g_ascii_strcasecmp(value, "yes") == 0;
}

const SectionController* shell_sections_controller(AppSection section) {
    switch (section) {
    case SECTION_DASHBOARD:
        return section_dashboard_get();
    case SECTION_AGENTS:
        return section_agents_get();
    case SECTION_USAGE:
        return section_usage_get();
    case SECTION_GENERAL:
        return section_general_get();
    case SECTION_CONFIG:
        return section_config_get();
    case SECTION_CHANNELS:
        return section_channels_get();
    case SECTION_SKILLS:
        return section_skills_get();
    case SECTION_WORKFLOWS:
        return section_workflows_get();
    case SECTION_CONTROL_ROOM:
        return section_control_room_get();
    case SECTION_ENVIRONMENT:
        return section_environment_get();
    case SECTION_DIAGNOSTICS:
        return section_diagnostics_get();
    case SECTION_LOGS:
        return section_logs_get();
    case SECTION_INSTANCES:
        return section_instances_get();
    case SECTION_DEBUG:
        return section_debug_get();
    case SECTION_SESSIONS:
        return section_sessions_get();
    case SECTION_CRON:
        return section_cron_get();
    case SECTION_ABOUT:
        return section_about_get();
    case SECTION_CHAT:
    case SECTION_COUNT:
        return NULL;
    default:
        return NULL;
    }
}
