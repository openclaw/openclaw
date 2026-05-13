/*
 * exec_approval_tray_model.h
 *
 * Tray-side mapping helpers between the persistent OpenClaw exec
 * approval quick-mode enum (`OcExecQuickMode`) and the canonical wire
 * tokens used in the tray helper protocol ("deny" / "ask" / "allow").
 *
 * This module is deliberately tiny and pure-C so the host (`tray.c`),
 * the registry (`debug_actions.c`), and unit tests can all share the
 * same string<->enum decision without re-deriving it. Centralising the
 * mapping here means a future addition to `OcExecQuickMode` only needs
 * one edit instead of touching every consumer.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_EXEC_APPROVAL_TRAY_MODEL_H
#define OPENCLAW_LINUX_EXEC_APPROVAL_TRAY_MODEL_H

#include <glib.h>

#include "exec_approval_store.h"

/*
 * Convert an `OcExecQuickMode` into the canonical lower-case wire
 * token. Returns NULL for values outside the known enum range. The
 * returned pointer is to a static literal — do not free.
 */
const char* exec_approval_tray_mode_to_string(OcExecQuickMode mode);

/*
 * Parse a canonical wire token ("deny" / "ask" / "allow") into an
 * `OcExecQuickMode`. Returns TRUE on match and writes the enum into
 * `*out` (when non-NULL); returns FALSE for unknown / NULL input and
 * leaves `*out` untouched.
 */
gboolean exec_approval_tray_mode_from_string(const char *s, OcExecQuickMode *out);

#endif /* OPENCLAW_LINUX_EXEC_APPROVAL_TRAY_MODEL_H */
