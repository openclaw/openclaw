#ifndef OPENCLAW_LINUX_HEALTH_HELPERS_H
#define OPENCLAW_LINUX_HEALTH_HELPERS_H

#include <glib.h>
#include "state.h"

void health_parse_probe_stdout(const gchar *stdout_buf, ProbeState *ps);

#endif // OPENCLAW_LINUX_HEALTH_HELPERS_H
