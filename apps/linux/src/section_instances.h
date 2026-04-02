/*
 * section_instances.h
 *
 * Instances section controller for the OpenClaw Linux Companion App.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include "section_controller.h"

const SectionController* section_instances_get(void);

/* Local instance card refresh (no RPC; uses local state/health/systemd).
 * Called by app_window on every tick for cheap local data. */
void section_instances_refresh_local(void);
