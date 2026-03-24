#ifndef OPENCLAW_LINUX_HEALTH_HELPERS_H
#define OPENCLAW_LINUX_HEALTH_HELPERS_H

#include <glib.h>
#include "state.h"

void health_parse_probe_stdout(const gchar *stdout_buf, ProbeState *ps);
gboolean health_gateway_arg_should_be_forwarded(const gchar *arg, const gchar *subcommand);
gboolean health_gateway_arg_consumes_next_value(const gchar *arg);

#endif // OPENCLAW_LINUX_HEALTH_HELPERS_H
