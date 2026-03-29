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
  'src/gateway_client.c',
  'src/state.c',
  'src/runtime_mode.c',
  'src/readiness.c',
  'src/notify.c',
  'src/diagnostics.c',
  'src/log.c'
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

test_gateway_exe = executable('test_gateway',
  ['tests/test_gateway.c', 'src/gateway_config.c', 'src/gateway_protocol.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('gateway', test_gateway_exe)
