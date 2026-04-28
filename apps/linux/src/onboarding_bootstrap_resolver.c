/*
 * onboarding_bootstrap_resolver.c
 *
 * Deterministic command resolution for the Linux onboarding bootstrap flow.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "onboarding_bootstrap_resolver.h"

#include <glib/gstdio.h>

static OnboardingBootstrapFindProgramFunc test_find_program = NULL;
static OnboardingBootstrapPathFunc test_executable_path = NULL;
static OnboardingBootstrapPathFunc test_current_dir = NULL;

static gchar* default_find_program(const gchar *program) {
    return g_find_program_in_path(program);
}

static gchar* default_executable_path(void) {
#ifdef __linux__
    return g_file_read_link("/proc/self/exe", NULL);
#else
    return NULL;
#endif
}

static gchar* default_current_dir(void) {
    return g_get_current_dir();
}

void onboarding_bootstrap_resolver_set_test_hooks(OnboardingBootstrapFindProgramFunc find_program,
                                                  OnboardingBootstrapPathFunc executable_path,
                                                  OnboardingBootstrapPathFunc current_dir) {
    test_find_program = find_program;
    test_executable_path = executable_path;
    test_current_dir = current_dir;
}

static gchar* call_find_program(const gchar *program) {
    OnboardingBootstrapFindProgramFunc fn = test_find_program ? test_find_program : default_find_program;
    return fn(program);
}

static gchar* call_executable_path(void) {
    OnboardingBootstrapPathFunc fn = test_executable_path ? test_executable_path : default_executable_path;
    return fn();
}

static gchar* call_current_dir(void) {
    OnboardingBootstrapPathFunc fn = test_current_dir ? test_current_dir : default_current_dir;
    return fn();
}

static gboolean path_has_dev_root_files(const gchar *dir) {
    if (!dir || dir[0] == '\0') {
        return FALSE;
    }
    g_autofree gchar *openclaw_mjs = g_build_filename(dir, "openclaw.mjs", NULL);
    g_autofree gchar *package_json = g_build_filename(dir, "package.json", NULL);
    return g_file_test(openclaw_mjs, G_FILE_TEST_IS_REGULAR) &&
           g_file_test(package_json, G_FILE_TEST_IS_REGULAR);
}

static gchar* find_dev_root_from(const gchar *start_path) {
    if (!start_path || start_path[0] == '\0') {
        return NULL;
    }

    g_autofree gchar *canonical = g_canonicalize_filename(start_path, NULL);
    g_autofree gchar *cursor = g_file_test(canonical, G_FILE_TEST_IS_DIR)
        ? g_strdup(canonical)
        : g_path_get_dirname(canonical);

    while (cursor && cursor[0] != '\0') {
        if (path_has_dev_root_files(cursor)) {
            return g_steal_pointer(&cursor);
        }
        g_autofree gchar *parent = g_path_get_dirname(cursor);
        if (!parent || g_strcmp0(parent, cursor) == 0) {
            break;
        }
        g_free(cursor);
        cursor = g_steal_pointer(&parent);
    }

    return NULL;
}

static gchar* find_dev_root(void) {
    g_autofree gchar *exe_path = call_executable_path();
    g_autofree gchar *from_exe = find_dev_root_from(exe_path);
    if (from_exe) {
        return g_steal_pointer(&from_exe);
    }

    g_autofree gchar *cwd = call_current_dir();
    return find_dev_root_from(cwd);
}

static gchar** make_openclaw_setup_argv(void) {
    return g_new0(gchar *, 3);
}

static gchar** make_openclaw_gateway_install_argv(void) {
    return g_new0(gchar *, 4);
}

static gchar** make_dev_setup_argv(const gchar *node, const gchar *repo_root) {
    gchar **argv = g_new0(gchar *, 4);
    argv[0] = g_strdup(node);
    argv[1] = g_build_filename(repo_root, "openclaw.mjs", NULL);
    argv[2] = g_strdup("setup");
    return argv;
}

static gchar** make_dev_gateway_install_argv(const gchar *node, const gchar *repo_root) {
    gchar **argv = g_new0(gchar *, 5);
    argv[0] = g_strdup(node);
    argv[1] = g_build_filename(repo_root, "openclaw.mjs", NULL);
    argv[2] = g_strdup("gateway");
    argv[3] = g_strdup("install");
    return argv;
}

static void fill_openclaw_argv(OnboardingBootstrapResolution *out, const gchar *openclaw_path) {
    out->kind = ONBOARDING_BOOTSTRAP_RESOLUTION_OPENCLAW_PATH;
    out->setup_argv = make_openclaw_setup_argv();
    out->setup_argv[0] = g_strdup(openclaw_path);
    out->setup_argv[1] = g_strdup("setup");
    out->gateway_install_argv = make_openclaw_gateway_install_argv();
    out->gateway_install_argv[0] = g_strdup(openclaw_path);
    out->gateway_install_argv[1] = g_strdup("gateway");
    out->gateway_install_argv[2] = g_strdup("install");
}

gboolean onboarding_bootstrap_resolve_commands(OnboardingBootstrapResolution *out) {
    if (!out) {
        return FALSE;
    }
    memset(out, 0, sizeof(*out));

    g_autofree gchar *openclaw = call_find_program("openclaw");
    if (openclaw) {
        fill_openclaw_argv(out, openclaw);
        return TRUE;
    }

    g_autofree gchar *node = call_find_program("node");
    if (!node) {
        out->kind = ONBOARDING_BOOTSTRAP_RESOLUTION_MISSING;
        out->missing_reason = g_strdup("The openclaw CLI is not on PATH, and node is not available for the development checkout fallback.");
        return FALSE;
    }

    g_autofree gchar *repo_root = find_dev_root();
    if (!repo_root) {
        out->kind = ONBOARDING_BOOTSTRAP_RESOLUTION_MISSING;
        out->missing_reason = g_strdup("The openclaw CLI is not on PATH, and no development checkout with openclaw.mjs and package.json was found.");
        return FALSE;
    }

    out->kind = ONBOARDING_BOOTSTRAP_RESOLUTION_DEV_TREE;
    out->repo_root = g_strdup(repo_root);
    out->setup_argv = make_dev_setup_argv(node, repo_root);
    out->gateway_install_argv = make_dev_gateway_install_argv(node, repo_root);
    return TRUE;
}

gchar** onboarding_bootstrap_resolution_dup_argv(const OnboardingBootstrapResolution *resolution,
                                                 OnboardingBootstrapStep step) {
    if (!resolution) {
        return NULL;
    }
    gchar **source = step == ONBOARDING_BOOTSTRAP_STEP_SETUP
        ? resolution->setup_argv
        : resolution->gateway_install_argv;
    return source ? g_strdupv(source) : NULL;
}

void onboarding_bootstrap_resolution_clear(OnboardingBootstrapResolution *resolution) {
    if (!resolution) {
        return;
    }
    g_clear_pointer(&resolution->repo_root, g_free);
    g_clear_pointer(&resolution->missing_reason, g_free);
    g_clear_pointer(&resolution->setup_argv, g_strfreev);
    g_clear_pointer(&resolution->gateway_install_argv, g_strfreev);
    memset(resolution, 0, sizeof(*resolution));
}

