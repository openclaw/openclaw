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
gio_dep = dependency('gio-2.0')
gio_unix_dep = dependency('gio-unix-2.0')
glib_dep = dependency('glib-2.0')

# Define LIBEXEC_PATH for the C compiler so tray.c knows where the installed helper lives
libexec_path = get_option('prefix') / get_option('libexecdir') / meson.project_name()
add_project_arguments('-DOPENCLAW_LIBEXEC_DIR="' + libexec_path + '"', language: 'c')

# Main app (GTK4 + Libadwaita + JSON-GLib + GIO)
sources = [
  'src/main.c',
  'src/tray.c',
  'src/systemd.c',
  'src/systemd_helpers.c',
  'src/health.c',
  'src/health_helpers.c',
  'src/state.c',
  'src/notify.c',
  'src/diagnostics.c',
  'src/log.c'
]

executable('openclaw-linux',
  sources,
  dependencies : [gtk4_dep, adwaita_dep, json_glib_dep, gio_dep, gio_unix_dep],
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
  ['tests/test_state.c', 'src/state.c', 'src/log.c'],
  dependencies : [glib_dep, gio_dep])
test('state', test_state_exe)

test_systemd_exe = executable('test_systemd_helpers',
  ['tests/test_systemd_helpers.c', 'src/systemd_helpers.c'],
  dependencies : [glib_dep, gio_dep, gio_unix_dep])
test('systemd_helpers', test_systemd_exe)

test_health_exe = executable('test_health_parse',
  ['tests/test_health_parse.c', 'src/health_helpers.c'],
  dependencies : [glib_dep, gio_dep, json_glib_dep])
test('health_parse', test_health_exe)
