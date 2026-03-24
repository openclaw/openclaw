#ifndef OPENCLAW_LINUX_SYSTEMD_HELPERS_H
#define OPENCLAW_LINUX_SYSTEMD_HELPERS_H

#include <glib.h>

gboolean systemd_is_gateway_unit_name(const gchar *unit_name);
gboolean systemd_is_gateway_unit(const gchar *filename, const gchar *contents);
gchar* systemd_normalize_unit_override(const gchar *raw_unit);
gchar* systemd_normalize_profile(const gchar *raw_profile);

gboolean systemd_parse_service_properties(GVariant *props, const gchar *home_dir, gchar ***exec_start_argv_out, gchar **working_directory_out, gchar ***environment_out);

// Exposed for testing
gchar** systemd_parse_single_env_file(const gchar *env_file, const gchar *home_dir, const gchar *unit_dir, gboolean is_optional, gchar **file_env);
gchar** systemd_parse_environment_file(const gchar *env_val, const gchar *home_dir, const gchar *unit_dir, gchar **file_env);

#endif // OPENCLAW_LINUX_SYSTEMD_HELPERS_H
