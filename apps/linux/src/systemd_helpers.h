#ifndef OPENCLAW_LINUX_SYSTEMD_HELPERS_H
#define OPENCLAW_LINUX_SYSTEMD_HELPERS_H

#include <glib.h>

gboolean systemd_is_gateway_unit(const gchar *filename, const gchar *contents);
gchar* systemd_normalize_unit_override(const gchar *raw_unit);
gchar* systemd_normalize_profile(const gchar *raw_profile);

#endif // OPENCLAW_LINUX_SYSTEMD_HELPERS_H
