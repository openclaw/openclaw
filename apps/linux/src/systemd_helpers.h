#ifndef OPENCLAW_LINUX_SYSTEMD_HELPERS_H
#define OPENCLAW_LINUX_SYSTEMD_HELPERS_H

#include <glib.h>

gboolean systemd_is_gateway_unit(const gchar *filename, const gchar *contents);
gchar* systemd_normalize_unit_override(const gchar *raw_unit);
gchar* systemd_normalize_profile(const gchar *raw_profile);

// Exposed for testing
gchar** systemd_parse_single_env_file(const gchar *env_file, const gchar *home_dir, const gchar *unit_dir, gboolean is_optional, gchar **file_env);
gchar** systemd_parse_environment_file(const gchar *env_val, const gchar *home_dir, const gchar *unit_dir, gchar **file_env);

#endif // OPENCLAW_LINUX_SYSTEMD_HELPERS_H
