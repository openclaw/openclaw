/*
  Simple DirectMedia Layer
  Copyright (C) 1997-2025 Sam Lantinga <slouken@libsdl.org>

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.
*/

#ifndef SDL_power_h_
#define SDL_power_h_

/**
 * # CategoryPower
 *
 * Header for the SDL power management routines.
 */

#include "SDL_stdinc.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/**
 * The basic state for the system's power supply.
 */
typedef enum SDL_PowerState
{
    SDL_POWERSTATE_UNKNOWN,      /**< cannot determine power status */
    SDL_POWERSTATE_ON_BATTERY,   /**< Not plugged in, running on the battery */
    SDL_POWERSTATE_NO_BATTERY,   /**< Plugged in, no battery available */
    SDL_POWERSTATE_CHARGING,     /**< Plugged in, charging battery */
    SDL_POWERSTATE_CHARGED       /**< Plugged in, battery charged */
} SDL_PowerState;

/**
 * Get the current power supply details.
 *
 * You should never take a battery status as absolute truth. Batteries
 * (especially failing batteries) are delicate hardware, and the values
 * reported here are best estimates based on what that hardware reports. It's
 * not uncommon for older batteries to lose stored power much faster than it
 * reports, or completely drain when reporting it has 20 percent left, etc.
 *
 * Battery status can change at any time; if you are concerned with power
 * state, you should call this function frequently, and perhaps ignore changes
 * until they seem to be stable for a few seconds.
 *
 * It's possible a platform can only report battery percentage or time left
 * but not both.
 *
 * \param seconds seconds of battery life left, you can pass a NULL here if
 *                you don't care, will return -1 if we can't determine a
 *                value, or we're not running on a battery.
 * \param percent percentage of battery life left, between 0 and 100, you can
 *                pass a NULL here if you don't care, will return -1 if we
 *                can't determine a value, or we're not running on a battery.
 * \returns an SDL_PowerState enum representing the current battery state.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC SDL_PowerState SDLCALL SDL_GetPowerInfo(int *seconds, int *percent);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_power_h_ */

/* vi: set ts=4 sw=4 expandtab: */
