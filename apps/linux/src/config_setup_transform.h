#ifndef OPENCLAW_LINUX_CONFIG_SETUP_TRANSFORM_H
#define OPENCLAW_LINUX_CONFIG_SETUP_TRANSFORM_H

#include <glib.h>

gchar* config_setup_apply_provider(const gchar *raw_json,
                                   const gchar *provider_id,
                                   const gchar *base_url,
                                   GError **error);

gchar* config_setup_apply_default_model(const gchar *raw_json,
                                        const gchar *provider_id,
                                        const gchar *model_id,
                                        GError **error);

#endif
