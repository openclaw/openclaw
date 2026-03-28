#ifndef OPENCLAW_LINUX_SYSTEMD_HELPERS_H
#define OPENCLAW_LINUX_SYSTEMD_HELPERS_H

#include <glib.h>

gboolean systemd_is_gateway_unit_name(const gchar *unit_name);
gboolean systemd_is_gateway_unit(const gchar *filename, const gchar *contents);
gchar* systemd_normalize_unit_override(const gchar *raw_unit);
gchar* systemd_normalize_profile(const gchar *raw_profile);

GPtrArray* systemd_helpers_get_user_unit_paths(const gchar *home_dir);
GPtrArray* systemd_helpers_get_system_unit_paths(void);

gchar* systemd_helpers_find_unit_file(const gchar *unit_name, const gchar *home_dir);
gchar* systemd_helpers_parse_unit_env(const gchar *unit_contents, const gchar *key);

#endif // OPENCLAW_LINUX_SYSTEMD_HELPERS_H
