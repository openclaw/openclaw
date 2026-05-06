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
  'src/main_open_dispatch.c',
  'src/deep_link.c',
  'src/browser_control_state.c',
  'src/config_browser_toggle.c',
  'src/tray.c',
  'src/systemd.c',
  'src/systemd_helpers.c',
  'src/gateway_config.c',
  'src/gateway_remote_config.c',
  'src/connection_mode_resolver.c',
  'src/remote_port_check.c',
  'src/remote_tunnel_command.c',
  'src/remote_tunnel.c',
  'src/remote_endpoint.c',
  'src/remote_probe.c',
  'src/connection_mode_coordinator.c',
  'src/gateway_http.c',
  'src/gateway_protocol.c',
  'src/gateway_ws.c',
  'src/device_identity.c',
  'src/device_auth_store.c',
  'src/device_pair_request_info.c',
  'src/device_pair_approval_window.c',
  'src/pairing_bootstrap_window.c',
  'src/device_pair_prompter.c',
  'src/exec_approval_request.c',
  'src/exec_approval_store.c',
  'src/exec_approval_window.c',
  'src/exec_approval_prompter.c',
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
  'src/debug_actions.c',
  'src/app_restart.c',
  'src/exec_approval_tray_model.c',
  'src/tray_protocol.c',
  'src/diagnostics.c',
  'src/display_model.c',
  'src/runtime_paths.c',
  'src/runtime_reveal.c',
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
  'src/onboarding_bootstrap_resolver.c',
  'src/onboarding_bootstrap.c',
  'src/onboarding_cli_detect.c',
  'src/onboarding_chat_validation.c',
  'src/onboarding_wizard.c',
  'src/log.c',
  'src/test_seams.c'
]

executable('openclaw-linux',
  sources,
  dependencies : [gtk4_dep, adwaita_dep, json_glib_dep, soup_dep, gio_dep, gio_unix_dep, sodium_dep],
  install : true)

# Production translation units minus the app entrypoint, for tests that
# need to link the real companion code (e.g. the section-controller
# contract audit) and provide their own main().
app_core_sources = []
foreach src : sources
  if src != 'src/main.c'
    app_core_sources += src
  endif
endforeach

# Tray helper (GTK3 + Ayatana AppIndicator)
# Installed as a private implementation detail into libexec
helper_sources = [
  'src/tray_helper.c',
  'src/tray_helper_protocol.c',
  'src/tray_protocol.c',
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
  ['tests/test_config.c', 'src/gateway_config.c', 'src/gateway_remote_config.c', 'src/config_setup_transform.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('config', test_config_exe)

test_gateway_remote_config_exe = executable('test_gateway_remote_config',
  ['tests/test_gateway_remote_config.c', 'src/gateway_remote_config.c'],
  dependencies : [glib_dep, json_glib_dep])
test('gateway_remote_config', test_gateway_remote_config_exe)

test_gateway_config_write_remote_exe = executable('test_gateway_config_write_remote',
  ['tests/test_gateway_config_write_remote.c',
   'src/gateway_config.c', 'src/gateway_remote_config.c',
   'src/config_setup_transform.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('gateway_config_write_remote', test_gateway_config_write_remote_exe)

test_connection_mode_resolver_exe = executable('test_connection_mode_resolver',
  ['tests/test_connection_mode_resolver.c', 'src/connection_mode_resolver.c'],
  dependencies : [glib_dep])
test('connection_mode_resolver', test_connection_mode_resolver_exe)

test_remote_tunnel_command_exe = executable('test_remote_tunnel_command',
  ['tests/test_remote_tunnel_command.c', 'src/remote_tunnel_command.c'],
  dependencies : [glib_dep])
test('remote_tunnel_command', test_remote_tunnel_command_exe)

test_connection_mode_coordinator_exe = executable(
  'test_connection_mode_coordinator',
  ['tests/test_connection_mode_coordinator.c',
   'src/connection_mode_coordinator.c',
   'src/remote_endpoint.c',
   'src/remote_tunnel.c',
   'src/remote_tunnel_command.c',
   'src/remote_port_check.c',
   'src/gateway_remote_config.c',
   'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('connection_mode_coordinator', test_connection_mode_coordinator_exe)

test_remote_tunnel_adopted_kill_exe = executable(
  'test_remote_tunnel_adopted_kill',
  ['tests/test_remote_tunnel_adopted_kill.c',
   'src/remote_tunnel.c', 'src/remote_tunnel_command.c',
   'src/remote_port_check.c',
   'src/gateway_remote_config.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('remote_tunnel_adopted_kill',
     test_remote_tunnel_adopted_kill_exe,
     timeout : 10)

test_remote_port_check_exe = executable('test_remote_port_check',
  ['tests/test_remote_port_check.c', 'src/remote_port_check.c'],
  dependencies : [glib_dep])
test('remote_port_check', test_remote_port_check_exe)

test_remote_endpoint_exe = executable('test_remote_endpoint',
  ['tests/test_remote_endpoint.c', 'src/remote_endpoint.c', 'src/log.c'],
  dependencies : [glib_dep, json_glib_dep])
test('remote_endpoint', test_remote_endpoint_exe)

test_remote_probe_timeout_exe = executable('test_remote_probe_timeout',
  ['tests/test_remote_probe_timeout.c',
   'src/remote_probe.c', 'src/gateway_remote_config.c',
   'src/gateway_http.c',
   'src/remote_port_check.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, soup_dep])
test('remote_probe_timeout', test_remote_probe_timeout_exe, timeout : 30)

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

test_section_debug_exe = executable('test_section_debug',
  ['tests/test_section_debug.c', 'src/section_debug.c', 'src/runtime_reveal.c',
   'src/debug_actions.c',
   'src/connection_mode_resolver.c', 'src/remote_endpoint.c',
   'src/remote_tunnel.c', 'src/remote_tunnel_command.c',
   'src/remote_port_check.c',
   'src/gateway_remote_config.c', 'src/product_state.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, gtk4_dep, adwaita_dep, json_glib_dep])
test('section_debug', test_section_debug_exe)

# Pure-C regression for the shared debug-action registry. Headless: the
# registry never imports GTK, and the test stubs out cross-module entry
# points (gateway_client_refresh, systemd_restart_gateway, etc.) plus
# the reveal-URI builders so the registry can be exercised end-to-end
# without standing up runtime_reveal.c's dependency tree.
test_debug_actions_exe = executable('test_debug_actions',
  ['tests/test_debug_actions.c', 'src/debug_actions.c'],
  dependencies : [glib_dep])
test('debug_actions', test_debug_actions_exe)

# Pure-C regression for the host↔helper line protocol formatter and
# parser. No GTK; only glib is needed.
test_tray_protocol_exe = executable('test_tray_protocol',
  ['tests/test_tray_protocol.c', 'src/tray_protocol.c'],
  dependencies : [glib_dep])
test('tray_protocol', test_tray_protocol_exe)

# Pure-C regression for the openclaw:// deep-link parser. Headless;
# only glib is needed (uses GUri for RFC-3986 parsing).
test_deep_link_exe = executable('test_deep_link',
  ['tests/test_deep_link.c', 'src/deep_link.c'],
  dependencies : [glib_dep])
test('deep_link', test_deep_link_exe)

# Pure-C regression for the helper-side parser/applier. Capture
# callbacks stand in for the GTK widget mutations so the suite stays
# headless.
test_tray_helper_protocol_exe = executable('test_tray_helper_protocol',
  ['tests/test_tray_helper_protocol.c',
   'src/tray_helper_protocol.c', 'src/tray_protocol.c'],
  dependencies : [glib_dep])
test('tray_helper_protocol', test_tray_helper_protocol_exe)

# Pure-C regression for the shared Browser Control state module
# (Tranche E finalization). The module is GTK-free and exposes a
# transport seam, so the tests install a stub transport and drive
# refresh / set callbacks directly without spinning up the gateway.
test_browser_control_state_exe = executable('test_browser_control_state',
  ['tests/test_browser_control_state.c', 'src/browser_control_state.c'],
  dependencies : [glib_dep])
test('browser_control_state', test_browser_control_state_exe)

# Hermetic regression for the Restart App argv builder. The actual
# spawn path is intentionally NOT exercised — see test source for the
# rationale.
test_app_restart_exe = executable('test_app_restart',
  ['tests/test_app_restart.c', 'src/app_restart.c'],
  dependencies : [glib_dep, gio_dep])
test('app_restart', test_app_restart_exe)

# Pure-C regression for the OcExecQuickMode <-> wire token mapping.
test_exec_approval_tray_model_exe = executable('test_exec_approval_tray_model',
  ['tests/test_exec_approval_tray_model.c',
   'src/exec_approval_tray_model.c'],
  dependencies : [glib_dep])
test('exec_approval_tray_model', test_exec_approval_tray_model_exe)

# Real-controller contract audit (Tranche E.3). Links the production
# section_*.c translation units through app_core_sources so every
# AppSection's SectionController is validated against the full
# required-callback contract. No GTK display is required: the test only
# inspects the static controller tables and never invokes build/refresh/
# destroy/invalidate. See tests/test_section_controllers_contract.c for
# the audit rationale.
test_section_controllers_contract_exe = executable('test_section_controllers_contract',
  ['tests/test_section_controllers_contract.c'] + app_core_sources,
  dependencies : [gtk4_dep, adwaita_dep, json_glib_dep, soup_dep, gio_dep, gio_unix_dep, sodium_dep])
test('section_controllers_contract', test_section_controllers_contract_exe)

test_onboarding_controller_exe = executable('test_onboarding_controller',
  ['tests/test_onboarding_controller.c', 'src/onboarding.c', 'src/test_seams.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, gtk4_dep, adwaita_dep])
test('onboarding_controller', test_onboarding_controller_exe)

test_onboarding_bootstrap_resolver_exe = executable('test_onboarding_bootstrap_resolver',
  ['tests/test_onboarding_bootstrap_resolver.c', 'src/onboarding_bootstrap_resolver.c'],
  dependencies : [glib_dep, gio_dep])
test('onboarding_bootstrap_resolver', test_onboarding_bootstrap_resolver_exe)

test_onboarding_bootstrap_exe = executable('test_onboarding_bootstrap',
  ['tests/test_onboarding_bootstrap.c',
   'src/onboarding_bootstrap.c',
   'src/onboarding_bootstrap_resolver.c'],
  dependencies : [glib_dep, gio_dep])
test('onboarding_bootstrap', test_onboarding_bootstrap_exe)

test_onboarding_wizard_model_exe = executable('test_onboarding_wizard_model',
  ['tests/test_onboarding_wizard_model.c', 'src/onboarding_wizard.c'],
  dependencies : [glib_dep, json_glib_dep])
test('onboarding_wizard_model', test_onboarding_wizard_model_exe)

test_onboarding_cli_detect_exe = executable('test_onboarding_cli_detect',
  ['tests/test_onboarding_cli_detect.c', 'src/onboarding_cli_detect.c'],
  dependencies : [glib_dep])
test('onboarding_cli_detect', test_onboarding_cli_detect_exe)

test_onboarding_chat_validation_exe = executable('test_onboarding_chat_validation',
  ['tests/test_onboarding_chat_validation.c', 'src/onboarding_chat_validation.c'],
  dependencies : [glib_dep])
test('onboarding_chat_validation', test_onboarding_chat_validation_exe)

test_gateway_exe = executable('test_gateway',
  ['tests/test_gateway.c', 'src/gateway_config.c', 'src/gateway_remote_config.c', 'src/gateway_protocol.c',
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

# Exec-approval Tranche B coverage. All three tests are headless: they
# stub out gateway_ws / gateway_rpc / exec_approval_window symbols and
# never spin up GTK/Adwaita.
test_exec_approval_request_exe = executable('test_exec_approval_request',
  ['tests/test_exec_approval_request.c', 'src/exec_approval_request.c'],
  dependencies : [glib_dep, json_glib_dep])
test('exec_approval_request', test_exec_approval_request_exe)

test_exec_approval_store_exe = executable('test_exec_approval_store',
  ['tests/test_exec_approval_store.c', 'src/exec_approval_store.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('exec_approval_store', test_exec_approval_store_exe)

test_exec_approval_prompter_exe = executable('test_exec_approval_prompter',
  ['tests/test_exec_approval_prompter.c',
   'src/exec_approval_prompter.c',
   'src/exec_approval_request.c',
   'src/exec_approval_store.c',
   'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep, gtk4_dep])
test('exec_approval_prompter', test_exec_approval_prompter_exe)

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
   'src/gateway_remote_config.c',
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
   'src/runtime_mode.c', 'src/gateway_config.c', 'src/gateway_remote_config.c',
   'src/runtime_paths.c', 'src/log.c'],
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
