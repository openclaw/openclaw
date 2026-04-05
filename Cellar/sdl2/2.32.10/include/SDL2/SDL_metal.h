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
 * # CategoryMetal
 *
 * Header file for functions to creating Metal layers and views on SDL
 * windows.
 */

#ifndef SDL_metal_h_
#define SDL_metal_h_

#include "SDL_video.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/**
 * A handle to a CAMetalLayer-backed NSView (macOS) or UIView (iOS/tvOS).
 *
 * This can be cast directly to an NSView or UIView.
 */
typedef void *SDL_MetalView;

/**
 *  \name Metal support functions
 */
/* @{ */

/**
 * Create a CAMetalLayer-backed NSView/UIView and attach it to the specified
 * window.
 *
 * On macOS, this does *not* associate a MTLDevice with the CAMetalLayer on
 * its own. It is up to user code to do that.
 *
 * The returned handle can be casted directly to a NSView or UIView. To access
 * the backing CAMetalLayer, call SDL_Metal_GetLayer().
 *
 * \since This function is available since SDL 2.0.12.
 *
 * \sa SDL_Metal_DestroyView
 * \sa SDL_Metal_GetLayer
 */
extern DECLSPEC SDL_MetalView SDLCALL SDL_Metal_CreateView(SDL_Window * window);

/**
 * Destroy an existing SDL_MetalView object.
 *
 * This should be called before SDL_DestroyWindow, if SDL_Metal_CreateView was
 * called after SDL_CreateWindow.
 *
 * \since This function is available since SDL 2.0.12.
 *
 * \sa SDL_Metal_CreateView
 */
extern DECLSPEC void SDLCALL SDL_Metal_DestroyView(SDL_MetalView view);

/**
 * Get a pointer to the backing CAMetalLayer for the given view.
 *
 * \since This function is available since SDL 2.0.14.
 *
 * \sa SDL_Metal_CreateView
 */
extern DECLSPEC void *SDLCALL SDL_Metal_GetLayer(SDL_MetalView view);

/**
 * Get the size of a window's underlying drawable in pixels (for use with
 * setting viewport, scissor & etc).
 *
 * \param window SDL_Window from which the drawable size should be queried.
 * \param w Pointer to variable for storing the width in pixels, may be NULL.
 * \param h Pointer to variable for storing the height in pixels, may be NULL.
 *
 * \since This function is available since SDL 2.0.14.
 *
 * \sa SDL_GetWindowSize
 * \sa SDL_CreateWindow
 */
extern DECLSPEC void SDLCALL SDL_Metal_GetDrawableSize(SDL_Window* window, int *w,
                                                       int *h);

/* @} *//* Metal support functions */

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_metal_h_ */
