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

/**
 * # CategoryGesture
 *
 * Include file for SDL gesture event handling.
 */

#ifndef SDL_gesture_h_
#define SDL_gesture_h_

#include "SDL_stdinc.h"
#include "SDL_error.h"
#include "SDL_video.h"

#include "SDL_touch.h"


#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

typedef Sint64 SDL_GestureID;

/* Function prototypes */

/**
 * Begin recording a gesture on a specified touch device or all touch devices.
 *
 * If the parameter `touchId` is -1 (i.e., all devices), this function will
 * always return 1, regardless of whether there actually are any devices.
 *
 * \param touchId the touch device id, or -1 for all touch devices.
 * \returns 1 on success or 0 if the specified device could not be found.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetTouchDevice
 */
extern DECLSPEC int SDLCALL SDL_RecordGesture(SDL_TouchID touchId);


/**
 * Save all currently loaded Dollar Gesture templates.
 *
 * \param dst a SDL_RWops to save to.
 * \returns the number of saved templates on success or 0 on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_LoadDollarTemplates
 * \sa SDL_SaveDollarTemplate
 */
extern DECLSPEC int SDLCALL SDL_SaveAllDollarTemplates(SDL_RWops *dst);

/**
 * Save a currently loaded Dollar Gesture template.
 *
 * \param gestureId a gesture id.
 * \param dst a SDL_RWops to save to.
 * \returns 1 on success or 0 on failure; call SDL_GetError() for more
 *          information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_LoadDollarTemplates
 * \sa SDL_SaveAllDollarTemplates
 */
extern DECLSPEC int SDLCALL SDL_SaveDollarTemplate(SDL_GestureID gestureId,SDL_RWops *dst);


/**
 * Load Dollar Gesture templates from a file.
 *
 * \param touchId a touch id.
 * \param src a SDL_RWops to load from.
 * \returns the number of loaded templates on success or a negative error code
 *          (or 0) on failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_SaveAllDollarTemplates
 * \sa SDL_SaveDollarTemplate
 */
extern DECLSPEC int SDLCALL SDL_LoadDollarTemplates(SDL_TouchID touchId, SDL_RWops *src);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_gesture_h_ */

/* vi: set ts=4 sw=4 expandtab: */
