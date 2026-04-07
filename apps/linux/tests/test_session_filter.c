/*
 * test_session_filter.c
 * Description: Unit tests for session filtering and dropdown choice rules.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>

#include "../src/session_filter.h"

static GatewaySession make_session(const gchar *key, const gchar *display_name, const gchar *subject) {
    GatewaySession s = {0};
    s.key = g_strdup(key);
    s.display_name = display_name ? g_strdup(display_name) : NULL;
    s.subject = subject ? g_strdup(subject) : NULL;
    return s;
}

static void free_session(GatewaySession *s) {
    g_free(s->key);
    g_free(s->display_name);
    g_free(s->subject);
}

static void test_system_noise_filters(void) {
    g_assert_true(session_filter_is_system_noise("agent:main:heartbeat"));
    g_assert_true(session_filter_is_system_noise("agent:main:cron:run:abc"));
    g_assert_false(session_filter_is_system_noise("agent:main:default"));
}

static void test_build_choices_adds_default(void) {
    g_autoptr(GPtrArray) choices = session_filter_build_choices("alice", NULL, 0);
    g_assert_cmpint((gint)choices->len, ==, 1);
    SessionChoice *c = g_ptr_array_index(choices, 0);
    g_assert_cmpstr(c->key, ==, "agent:alice:default");
    g_assert_cmpstr(c->label, ==, "default (new)");
}

static void test_build_choices_filters_and_labels(void) {
    GatewaySession sessions[4] = {
        make_session("agent:alice:room:heartbeat", "Heartbeat", NULL),
        make_session("agent:alice:cron:run:abc", "Run", NULL),
        make_session("agent:alice:telegram:42", "Chat with Bob", NULL),
        make_session("agent:alice:matrix:99", NULL, "Team room"),
    };

    g_autoptr(GPtrArray) choices = session_filter_build_choices("alice", sessions, 4);
    g_assert_cmpint((gint)choices->len, ==, 3);

    SessionChoice *c0 = g_ptr_array_index(choices, 0);
    SessionChoice *c1 = g_ptr_array_index(choices, 1);
    SessionChoice *c2 = g_ptr_array_index(choices, 2);

    g_assert_cmpstr(c0->key, ==, "agent:alice:telegram:42");
    g_assert_cmpstr(c0->label, ==, "Chat with Bob");

    g_assert_cmpstr(c1->key, ==, "agent:alice:matrix:99");
    g_assert_cmpstr(c1->label, ==, "Team room");

    g_assert_cmpstr(c2->key, ==, "agent:alice:default");

    for (gint i = 0; i < 4; i++) {
        free_session(&sessions[i]);
    }
}

static void test_no_duplicate_default(void) {
    GatewaySession sessions[2] = {
        make_session("agent:alice:default", NULL, NULL),
        make_session("agent:alice:telegram:1", NULL, NULL),
    };

    g_autoptr(GPtrArray) choices = session_filter_build_choices("alice", sessions, 2);
    gint default_count = 0;
    for (guint i = 0; i < choices->len; i++) {
        SessionChoice *c = g_ptr_array_index(choices, i);
        if (g_strcmp0(c->key, "agent:alice:default") == 0) {
            default_count++;
        }
    }
    g_assert_cmpint(default_count, ==, 1);

    for (gint i = 0; i < 2; i++) {
        free_session(&sessions[i]);
    }
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/session_filter/system_noise", test_system_noise_filters);
    g_test_add_func("/session_filter/default_added", test_build_choices_adds_default);
    g_test_add_func("/session_filter/filter_and_labels", test_build_choices_filters_and_labels);
    g_test_add_func("/session_filter/no_duplicate_default", test_no_duplicate_default);

    return g_test_run();
}
