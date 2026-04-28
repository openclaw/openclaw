/*
 * test_onboarding_bootstrap_resolver.c
 *
 * Headless coverage for deterministic Linux onboarding bootstrap command
 * resolution.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/onboarding_bootstrap_resolver.h"

#include <glib.h>
#include <glib/gstdio.h>

static gchar *fake_openclaw = NULL;
static gchar *fake_node = NULL;
static gchar *fake_executable_path = NULL;
static gchar *fake_current_dir = NULL;

static gchar* test_find_program(const gchar *program) {
    if (g_strcmp0(program, "openclaw") == 0 && fake_openclaw) {
        return g_strdup(fake_openclaw);
    }
    if (g_strcmp0(program, "node") == 0 && fake_node) {
        return g_strdup(fake_node);
    }
    return NULL;
}

static gchar* test_executable_path(void) {
    return fake_executable_path ? g_strdup(fake_executable_path) : NULL;
}

static gchar* test_current_dir(void) {
    return fake_current_dir ? g_strdup(fake_current_dir) : NULL;
}

static void reset_hooks(void) {
    g_clear_pointer(&fake_openclaw, g_free);
    g_clear_pointer(&fake_node, g_free);
    g_clear_pointer(&fake_executable_path, g_free);
    g_clear_pointer(&fake_current_dir, g_free);
    onboarding_bootstrap_resolver_set_test_hooks(test_find_program,
                                                 test_executable_path,
                                                 test_current_dir);
}

static gchar* make_repo_tree(void) {
    g_autofree gchar *root = g_dir_make_tmp("openclaw-bootstrap-resolver-XXXXXX", NULL);
    g_assert_nonnull(root);
    g_autofree gchar *openclaw_mjs = g_build_filename(root, "openclaw.mjs", NULL);
    g_autofree gchar *package_json = g_build_filename(root, "package.json", NULL);
    g_assert_true(g_file_set_contents(openclaw_mjs, "#!/usr/bin/env node\n", -1, NULL));
    g_assert_true(g_file_set_contents(package_json, "{\"name\":\"openclaw\"}\n", -1, NULL));

    g_autofree gchar *apps = g_build_filename(root, "apps", NULL);
    g_autofree gchar *linux_dir = g_build_filename(apps, "linux", NULL);
    g_autofree gchar *build = g_build_filename(linux_dir, "build", NULL);
    g_assert_cmpint(g_mkdir(apps, 0700), ==, 0);
    g_assert_cmpint(g_mkdir(linux_dir, 0700), ==, 0);
    g_assert_cmpint(g_mkdir(build, 0700), ==, 0);
    return g_steal_pointer(&root);
}

static void remove_repo_tree(const gchar *root) {
    if (!root) return;
    g_autofree gchar *openclaw_mjs = g_build_filename(root, "openclaw.mjs", NULL);
    g_autofree gchar *package_json = g_build_filename(root, "package.json", NULL);
    g_autofree gchar *build = g_build_filename(root, "apps", "linux", "build", NULL);
    g_autofree gchar *linux_dir = g_build_filename(root, "apps", "linux", NULL);
    g_autofree gchar *apps = g_build_filename(root, "apps", NULL);
    g_remove(openclaw_mjs);
    g_remove(package_json);
    g_rmdir(build);
    g_rmdir(linux_dir);
    g_rmdir(apps);
    g_rmdir(root);
}

static void assert_no_shell(const OnboardingBootstrapResolution *res) {
    g_assert_false(res->uses_shell);
    g_assert_nonnull(res->setup_argv);
    g_assert_nonnull(res->gateway_install_argv);
    for (gchar **it = res->setup_argv; it && *it; it++) {
        g_assert_cmpstr(*it, !=, "sh");
        g_assert_cmpstr(*it, !=, "-c");
    }
    for (gchar **it = res->gateway_install_argv; it && *it; it++) {
        g_assert_cmpstr(*it, !=, "sh");
        g_assert_cmpstr(*it, !=, "-c");
    }
}

static void test_finds_openclaw_on_path(void) {
    reset_hooks();
    fake_openclaw = g_strdup("/usr/local/bin/openclaw");

    OnboardingBootstrapResolution res = {0};
    g_assert_true(onboarding_bootstrap_resolve_commands(&res));
    g_assert_cmpint(res.kind, ==, ONBOARDING_BOOTSTRAP_RESOLUTION_OPENCLAW_PATH);
    g_assert_cmpstr(res.setup_argv[0], ==, "/usr/local/bin/openclaw");
    g_assert_cmpstr(res.setup_argv[1], ==, "setup");
    g_assert_cmpstr(res.gateway_install_argv[0], ==, "/usr/local/bin/openclaw");
    g_assert_cmpstr(res.gateway_install_argv[1], ==, "gateway");
    g_assert_cmpstr(res.gateway_install_argv[2], ==, "install");
    assert_no_shell(&res);
    onboarding_bootstrap_resolution_clear(&res);
}

static void test_falls_back_to_dev_tree(void) {
    reset_hooks();
    fake_node = g_strdup("/usr/bin/node");
    g_autofree gchar *root = make_repo_tree();
    fake_executable_path = g_build_filename(root, "apps", "linux", "build", "openclaw-linux", NULL);

    OnboardingBootstrapResolution res = {0};
    g_assert_true(onboarding_bootstrap_resolve_commands(&res));
    g_assert_cmpint(res.kind, ==, ONBOARDING_BOOTSTRAP_RESOLUTION_DEV_TREE);
    g_assert_cmpstr(res.repo_root, ==, root);
    g_assert_cmpstr(res.setup_argv[0], ==, "/usr/bin/node");
    g_assert_true(g_str_has_suffix(res.setup_argv[1], "openclaw.mjs"));
    g_assert_cmpstr(res.setup_argv[2], ==, "setup");
    g_assert_cmpstr(res.gateway_install_argv[2], ==, "gateway");
    g_assert_cmpstr(res.gateway_install_argv[3], ==, "install");
    assert_no_shell(&res);
    onboarding_bootstrap_resolution_clear(&res);
    remove_repo_tree(root);
}

static void test_walks_up_from_apps_linux_build(void) {
    reset_hooks();
    fake_node = g_strdup("/usr/bin/node");
    g_autofree gchar *root = make_repo_tree();
    fake_current_dir = g_build_filename(root, "apps", "linux", "build", NULL);

    OnboardingBootstrapResolution res = {0};
    g_assert_true(onboarding_bootstrap_resolve_commands(&res));
    g_assert_cmpint(res.kind, ==, ONBOARDING_BOOTSTRAP_RESOLUTION_DEV_TREE);
    g_assert_cmpstr(res.repo_root, ==, root);
    assert_no_shell(&res);
    onboarding_bootstrap_resolution_clear(&res);
    remove_repo_tree(root);
}

static void test_missing_node_fails(void) {
    reset_hooks();
    g_autofree gchar *root = make_repo_tree();
    fake_current_dir = g_build_filename(root, "apps", "linux", "build", NULL);

    OnboardingBootstrapResolution res = {0};
    g_assert_false(onboarding_bootstrap_resolve_commands(&res));
    g_assert_cmpint(res.kind, ==, ONBOARDING_BOOTSTRAP_RESOLUTION_MISSING);
    g_assert_nonnull(res.missing_reason);
    g_assert_null(res.setup_argv);
    onboarding_bootstrap_resolution_clear(&res);
    remove_repo_tree(root);
}

static void test_missing_openclaw_mjs_fails(void) {
    reset_hooks();
    fake_node = g_strdup("/usr/bin/node");
    g_autofree gchar *root = g_dir_make_tmp("openclaw-bootstrap-resolver-empty-XXXXXX", NULL);
    g_assert_nonnull(root);
    fake_current_dir = g_strdup(root);

    OnboardingBootstrapResolution res = {0};
    g_assert_false(onboarding_bootstrap_resolve_commands(&res));
    g_assert_cmpint(res.kind, ==, ONBOARDING_BOOTSTRAP_RESOLUTION_MISSING);
    g_assert_nonnull(res.missing_reason);
    onboarding_bootstrap_resolution_clear(&res);
    g_rmdir(root);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/onboarding/bootstrap_resolver/openclaw_path", test_finds_openclaw_on_path);
    g_test_add_func("/onboarding/bootstrap_resolver/dev_tree", test_falls_back_to_dev_tree);
    g_test_add_func("/onboarding/bootstrap_resolver/apps_linux_build", test_walks_up_from_apps_linux_build);
    g_test_add_func("/onboarding/bootstrap_resolver/missing_node", test_missing_node_fails);
    g_test_add_func("/onboarding/bootstrap_resolver/missing_openclaw_mjs", test_missing_openclaw_mjs_fails);
    return g_test_run();
}

