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

# Define LIBEXEC_PATH for the C compiler so tray.c knows where the installed helper lives
libexec_path = get_option('prefix') / get_option('libexecdir') / meson.project_name()
add_project_arguments('-DOPENCLAW_LIBEXEC_DIR="' + libexec_path + '"', language: 'c')

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
  'src/gateway_rpc.c',
  'src/gateway_data.c',
  'src/gateway_mutations.c',
  'src/gateway_client.c',
  'src/state.c',
  'src/runtime_mode.c',
  'src/readiness.c',
  'src/notify.c',
  'src/diagnostics.c',
  'src/display_model.c',
  'src/session_filter.c',
  'src/markdown_render.c',
  'src/chat_blocks.c',
  'src/format_utils.c',
  'src/ui_model_utils.c',
  'src/config_setup_transform.c',
  'src/app_window.c',
  'src/section_chat.c',
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
  'src/log.c',
  'src/test_seams.c'
]

executable('openclaw-linux',
  sources,
  dependencies : [gtk4_dep, adwaita_dep, json_glib_dep, soup_dep, gio_dep, gio_unix_dep],
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

test_seams_exe = executable('test_seams',
  ['tests/test_seams.c', 'src/test_seams.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('seams', test_seams_exe)

test_gateway_exe = executable('test_gateway',
  ['tests/test_gateway.c', 'src/gateway_config.c', 'src/gateway_protocol.c',
   'src/state.c', 'src/runtime_mode.c', 'src/readiness.c', 'src/log.c',
   'src/test_seams.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('gateway', test_gateway_exe)

test_display_model_exe = executable('test_display_model',
  ['tests/test_display_model.c', 'src/display_model.c', 'src/readiness.c',
   'src/runtime_mode.c', 'src/gateway_config.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('display_model', test_display_model_exe)

test_gateway_data_exe = executable('test_gateway_data',
  ['tests/test_gateway_data.c', 'src/gateway_data.c'],
  dependencies : [glib_dep, json_glib_dep])
test('gateway_data', test_gateway_data_exe)

test_gateway_rpc_exe = executable('test_gateway_rpc',
  ['tests/test_gateway_rpc.c', 'src/gateway_rpc.c', 'src/gateway_protocol.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('gateway_rpc', test_gateway_rpc_exe)

test_rpc_mutations_exe = executable('test_rpc_mutations',
  ['tests/test_rpc_mutations.c', 'src/gateway_mutations.c', 'src/test_seams.c'],
  dependencies : [glib_dep, json_glib_dep])
test('rpc_mutations', test_rpc_mutations_exe)

test_rpc_lifecycle_exe = executable('test_rpc_lifecycle',
  ['tests/test_rpc_lifecycle.c', 'src/gateway_rpc.c', 'src/gateway_protocol.c',
   'src/gateway_data.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
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
