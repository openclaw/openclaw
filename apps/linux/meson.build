#
# apps/linux/meson.build
#
# Linux companion app build definition.
# Orchestrates the compilation of the main GTK4 app and the private
# GTK3 tray helper, ensuring the helper is installed to libexecdir.
#
# Author: Thiago Camargo <thiagocmc@proton.me>
#

project('openclaw-linux-companion', 'c',
  version : '0.1.0',
  default_options : ['warning_level=2'])

gtk4_dep = dependency('gtk4')
adwaita_dep = dependency('libadwaita-1')
appindicator_dep = dependency('ayatana-appindicator3-0.1')
gtk3_dep = dependency('gtk+-3.0')
json_glib_dep = dependency('json-glib-1.0')
soup_dep = dependency('libsoup-3.0')
gio_dep = dependency('gio-2.0')
gio_unix_dep = dependency('gio-unix-2.0')
glib_dep = dependency('glib-2.0')
sodium_dep = dependency('libsodium')

app_version = meson.project_version()
git_commit = run_command('git', 'rev-parse', '--short', 'HEAD', check : false).stdout().strip()
build_timestamp = run_command('date', '-u', '+%Y-%m-%dT%H:%M:%SZ', check : false).stdout().strip()
if git_commit == ''
  git_commit = 'unknown'
endif

# Define LIBEXEC_PATH for the C compiler so tray.c knows where the installed helper lives
libexec_path = get_option('prefix') / get_option('libexecdir') / meson.project_name()
add_project_arguments('-DOPENCLAW_LIBEXEC_DIR="' + libexec_path + '"', language: 'c')
add_project_arguments('-DOPENCLAW_APP_VERSION="' + app_version + '"', language: 'c')
add_project_arguments('-DOPENCLAW_GIT_COMMIT="' + git_commit + '"', language: 'c')
add_project_arguments('-DOPENCLAW_BUILD_TIMESTAMP="' + build_timestamp + '"', language: 'c')

# Main app (GTK4 + Libadwaita + JSON-GLib + libsoup-3.0 + GIO)
sources = [
  'src/main.c',
  'src/tray.c',
  'src/systemd.c',
  'src/systemd_helpers.c',
  'src/gateway_config.c',
  'src/gateway_http.c',
  'src/gateway_protocol.c',
  'src/gateway_ws.c',
  'src/device_identity.c',
  'src/device_auth_store.c',
  'src/device_pair_request_info.c',
  'src/device_pair_approval_window.c',
  'src/pairing_bootstrap_window.c',
  'src/device_pair_prompter.c',
  'src/gateway_rpc.c',
  'src/gateway_data.c',
  'src/gateway_mutations.c',
  'src/gateway_client.c',
  'src/product_state.c',
  'src/product_coordinator.c',
  'src/state.c',
  'src/runtime_mode.c',
  'src/readiness.c',
  'src/notify.c',
  'src/diagnostics.c',
  'src/display_model.c',
  'src/runtime_paths.c',
  'src/session_filter.c',
  'src/markdown_render.c',
  'src/chat_blocks.c',
  'src/format_utils.c',
  'src/ui_model_utils.c',
  'src/config_setup_transform.c',
  'src/shell_sections.c',
  'src/section_about.c',
  'src/section_dashboard.c',
  'src/section_general.c',
  'src/section_config.c',
  'src/section_diagnostics.c',
  'src/section_environment.c',
  'src/section_debug.c',
  'src/app_window.c',
  'src/app_window_section_tag.c',
  'src/chat_controller.c',
  'src/chat_window.c',
  'src/section_agents.c',
  'src/section_usage.c',
  'src/section_channels.c',
  'src/section_skills.c',
  'src/section_workflows.c',
  'src/section_control_room.c',
  'src/section_logs.c',
  'src/section_sessions.c',
  'src/section_cron.c',
  'src/section_instances.c',
  'src/onboarding.c',
  'src/onboarding_view.c',
  'src/log.c',
  'src/test_seams.c'
]

executable('openclaw-linux',
  sources,
  dependencies : [gtk4_dep, adwaita_dep, json_glib_dep, soup_dep, gio_dep, gio_unix_dep, sodium_dep],
  install : true)

# Tray helper (GTK3 + Ayatana AppIndicator)
# Installed as a private implementation detail into libexec
helper_sources = [
  'src/tray_helper.c'
]

executable('openclaw-tray-helper',
  helper_sources,
  dependencies : [gtk3_dep, appindicator_dep, gio_dep, gio_unix_dep],
  install : true,
  install_dir : get_option('libexecdir') / meson.project_name())

install_data('ai.openclaw.Companion.desktop',
  install_dir : get_option('datadir') / 'applications')

# Local Tests
test_state_exe = executable('test_state',
  ['tests/test_state.c', 'src/state.c', 'src/runtime_mode.c', 'src/readiness.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep])
test('state', test_state_exe)

test_systemd_exe = executable('test_systemd_helpers',
  ['tests/test_systemd_helpers.c', 'src/systemd_helpers.c'],
  dependencies : [glib_dep, gio_dep, gio_unix_dep])
test('systemd_helpers', test_systemd_exe)

test_readiness_exe = executable('test_readiness',
  ['tests/test_readiness.c', 'src/readiness.c'],
  dependencies : [glib_dep])
test('readiness', test_readiness_exe)

test_runtime_mode_exe = executable('test_runtime_mode',
  ['tests/test_runtime_mode.c', 'src/state.c', 'src/runtime_mode.c', 'src/readiness.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep])
test('runtime_mode', test_runtime_mode_exe)

test_runtime_mode_pres_exe = executable('test_runtime_mode_presentation',
  ['tests/test_runtime_mode_presentation.c', 'src/runtime_mode.c'],
  dependencies : [glib_dep])
test('runtime_mode_presentation', test_runtime_mode_pres_exe)

test_config_exe = executable('test_config',
  ['tests/test_config.c', 'src/gateway_config.c', 'src/config_setup_transform.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('config', test_config_exe)

test_product_state_exe = executable('test_product_state',
  ['tests/test_product_state.c', 'src/product_state.c'],
  dependencies : [glib_dep])
test('product_state', test_product_state_exe)

test_product_coordinator_exe = executable('test_product_coordinator',
  ['tests/test_product_coordinator.c', 'src/product_coordinator.c'],
  dependencies : [glib_dep, gtk4_dep, json_glib_dep])
test('product_coordinator', test_product_coordinator_exe)

test_seams_exe = executable('test_seams',
  ['tests/test_seams.c', 'src/test_seams.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('seams', test_seams_exe)

test_shell_sections_exe = executable('test_shell_sections',
  ['tests/test_shell_sections.c', 'src/shell_sections.c'],
  dependencies : [glib_dep, gtk4_dep])
test('shell_sections', test_shell_sections_exe)

test_shell_sections_display_exe = executable('test_shell_sections_display',
  ['tests/test_shell_sections_display.c', 'src/shell_sections.c'],
  dependencies : [glib_dep, gtk4_dep])
test('shell_sections_display', test_shell_sections_display_exe)

test_onboarding_controller_exe = executable('test_onboarding_controller',
  ['tests/test_onboarding_controller.c', 'src/onboarding.c', 'src/test_seams.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, gtk4_dep, adwaita_dep])
test('onboarding_controller', test_onboarding_controller_exe)

test_gateway_exe = executable('test_gateway',
  ['tests/test_gateway.c', 'src/gateway_config.c', 'src/gateway_protocol.c',
   'src/device_identity.c', 'src/device_auth_store.c',
   'src/state.c', 'src/runtime_mode.c', 'src/readiness.c', 'src/log.c',
   'src/test_seams.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, sodium_dep])
test('gateway', test_gateway_exe)

test_device_identity_exe = executable('test_device_identity',
  ['tests/test_device_identity.c', 'src/device_identity.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, sodium_dep])
test('device_identity', test_device_identity_exe)

test_device_auth_store_exe = executable('test_device_auth_store',
  ['tests/test_device_auth_store.c', 'src/device_auth_store.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('device_auth_store', test_device_auth_store_exe)

# End-to-end lifecycle for the device-token repair contract: exercises
# store ↔ connect-builder ↔ hello-ok parse as a single composed flow so
# the repair path itself is regression-guarded, not just its pieces.
test_token_repair_exe = executable('test_token_repair',
  ['tests/test_token_repair.c',
   'src/device_auth_store.c', 'src/device_identity.c',
   'src/gateway_protocol.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, sodium_dep])
test('token_repair', test_token_repair_exe)

test_device_pair_prompter_exe = executable('test_device_pair_prompter',
  ['tests/test_device_pair_prompter.c',
   'src/device_pair_prompter.c', 'src/device_pair_request_info.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, gtk4_dep])
test('device_pair_prompter', test_device_pair_prompter_exe)

# Pure-C coverage for the Pango-markup body builder used by the approval
# dialog. Uses only GLib (g_markup_escape_text), so no GTK/Adwaita link.
test_pair_approval_body_exe = executable('test_pair_approval_body',
  ['tests/test_pair_approval_body.c', 'src/device_pair_request_info.c'],
  dependencies : [glib_dep, gtk4_dep])
test('pair_approval_body', test_pair_approval_body_exe)

# Pure-C regression for the sidebar-row → AppSection tag encoding used
# by the main-window routing. Guards the "Dashboard (enum 0) stuck"
# bug. Links only the 30-line helper TU; no main window, no display.
test_app_window_routing_exe = executable('test_app_window_routing',
  ['tests/test_app_window_routing.c', 'src/app_window_section_tag.c'],
  dependencies : [glib_dep, gtk4_dep])
test('app_window_routing', test_app_window_routing_exe)

# Pure-C regression for the default-model → catalog-entry matcher,
# which is what decides whether the chat gate resolves or stays blocked
# on "Selected model unavailable". Handles the provider-prefixed vs
# bare-id mismatch that made Chat blind to the catalog in Issue 2.
test_model_catalog_match_exe = executable('test_model_catalog_match',
  ['tests/test_model_catalog_match.c', 'src/display_model.c',
   'src/readiness.c', 'src/runtime_mode.c', 'src/gateway_config.c',
   'src/runtime_paths.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('model_catalog_match', test_model_catalog_match_exe)

# Headless coverage for the pairing bootstrap window's state-cache
# contract. Links the real module but never calls gtk_init()/show(); the
# tests exercise the documented `_test_update_state` / `_test_clear_state`
# seams which update cache + re-render without touching widgets.
test_pairing_bootstrap_window_exe = executable('test_pairing_bootstrap_window',
  ['tests/test_pairing_bootstrap_window.c',
   'src/pairing_bootstrap_window.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, gtk4_dep, adwaita_dep])
test('pairing_bootstrap_window', test_pairing_bootstrap_window_exe)

test_display_model_exe = executable('test_display_model',
  ['tests/test_display_model.c', 'src/display_model.c', 'src/readiness.c',
   'src/runtime_mode.c', 'src/gateway_config.c', 'src/runtime_paths.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('display_model', test_display_model_exe)

test_gateway_data_exe = executable('test_gateway_data',
  ['tests/test_gateway_data.c', 'src/gateway_data.c'],
  dependencies : [glib_dep, json_glib_dep])
test('gateway_data', test_gateway_data_exe)

test_gateway_rpc_exe = executable('test_gateway_rpc',
  ['tests/test_gateway_rpc.c', 'src/gateway_rpc.c', 'src/gateway_protocol.c',
   'src/device_identity.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, sodium_dep])
test('gateway_rpc', test_gateway_rpc_exe)

test_rpc_mutations_exe = executable('test_rpc_mutations',
  ['tests/test_rpc_mutations.c', 'src/gateway_mutations.c', 'src/test_seams.c'],
  dependencies : [glib_dep, json_glib_dep])
test('rpc_mutations', test_rpc_mutations_exe)

test_rpc_lifecycle_exe = executable('test_rpc_lifecycle',
  ['tests/test_rpc_lifecycle.c', 'src/gateway_rpc.c', 'src/gateway_protocol.c',
   'src/gateway_data.c', 'src/device_identity.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, sodium_dep])
test('rpc_lifecycle', test_rpc_lifecycle_exe)

test_session_filter_exe = executable('test_session_filter',
  ['tests/test_session_filter.c', 'src/session_filter.c', 'src/gateway_data.c'],
  dependencies : [glib_dep, json_glib_dep])
test('session_filter', test_session_filter_exe)

test_markdown_render_exe = executable('test_markdown_render',
  ['tests/test_markdown_render.c', 'src/markdown_render.c'],
  dependencies : [glib_dep])
test('markdown_render', test_markdown_render_exe)

test_chat_blocks_exe = executable('test_chat_blocks',
  ['tests/test_chat_blocks.c', 'src/chat_blocks.c'],
  dependencies : [glib_dep, json_glib_dep])
test('chat_blocks', test_chat_blocks_exe)

test_format_utils_exe = executable('test_format_utils',
  ['tests/test_format_utils.c', 'src/format_utils.c'],
  dependencies : [glib_dep])
test('format_utils', test_format_utils_exe)
