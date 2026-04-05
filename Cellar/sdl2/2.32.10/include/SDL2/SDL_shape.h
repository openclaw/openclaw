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

#ifndef SDL_shape_h_
#define SDL_shape_h_

#include "SDL_stdinc.h"
#include "SDL_pixels.h"
#include "SDL_rect.h"
#include "SDL_surface.h"
#include "SDL_video.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/** \file SDL_shape.h
 *
 * Header file for the shaped window API.
 */

#define SDL_NONSHAPEABLE_WINDOW -1
#define SDL_INVALID_SHAPE_ARGUMENT -2
#define SDL_WINDOW_LACKS_SHAPE -3

/**
 * Create a window that can be shaped with the specified position, dimensions,
 * and flags.
 *
 * \param title The title of the window, in UTF-8 encoding.
 * \param x The x position of the window, SDL_WINDOWPOS_CENTERED, or
 *          SDL_WINDOWPOS_UNDEFINED.
 * \param y The y position of the window, SDL_WINDOWPOS_CENTERED, or
 *          SDL_WINDOWPOS_UNDEFINED.
 * \param w The width of the window.
 * \param h The height of the window.
 * \param flags The flags for the window, a mask of SDL_WINDOW_BORDERLESS with
 *              any of the following: SDL_WINDOW_OPENGL,
 *              SDL_WINDOW_INPUT_GRABBED, SDL_WINDOW_HIDDEN,
 *              SDL_WINDOW_RESIZABLE, SDL_WINDOW_MAXIMIZED,
 *              SDL_WINDOW_MINIMIZED, SDL_WINDOW_BORDERLESS is always set, and
 *              SDL_WINDOW_FULLSCREEN is always unset.
 * \return the window created, or NULL if window creation failed.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_DestroyWindow
 */
extern DECLSPEC SDL_Window * SDLCALL SDL_CreateShapedWindow(const char *title,unsigned int x,unsigned int y,unsigned int w,unsigned int h,Uint32 flags);

/**
 * Return whether the given window is a shaped window.
 *
 * \param window The window to query for being shaped.
 * \return SDL_TRUE if the window is a window that can be shaped, SDL_FALSE if
 *         the window is unshaped or NULL.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_CreateShapedWindow
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IsShapedWindow(const SDL_Window *window);

/** \brief An enum denoting the specific type of contents present in an SDL_WindowShapeParams union. */
typedef enum {
    /** \brief The default mode, a binarized alpha cutoff of 1. */
    ShapeModeDefault,
    /** \brief A binarized alpha cutoff with a given integer value. */
    ShapeModeBinarizeAlpha,
    /** \brief A binarized alpha cutoff with a given integer value, but with the opposite comparison. */
    ShapeModeReverseBinarizeAlpha,
    /** \brief A color key is applied. */
    ShapeModeColorKey
} WindowShapeMode;

#define SDL_SHAPEMODEALPHA(mode) (mode == ShapeModeDefault || mode == ShapeModeBinarizeAlpha || mode == ShapeModeReverseBinarizeAlpha)

/** \brief A union containing parameters for shaped windows. */
typedef union {
    /** \brief A cutoff alpha value for binarization of the window shape's alpha channel. */
    Uint8 binarizationCutoff;
    SDL_Color colorKey;
} SDL_WindowShapeParams;

/** \brief A struct that tags the SDL_WindowShapeParams union with an enum describing the type of its contents. */
typedef struct SDL_WindowShapeMode {
    /** \brief The mode of these window-shape parameters. */
    WindowShapeMode mode;
    /** \brief Window-shape parameters. */
    SDL_WindowShapeParams parameters;
} SDL_WindowShapeMode;

/**
 * Set the shape and parameters of a shaped window.
 *
 * \param window The shaped window whose parameters should be set.
 * \param shape A surface encoding the desired shape for the window.
 * \param shape_mode The parameters to set for the shaped window.
 * \return 0 on success, SDL_INVALID_SHAPE_ARGUMENT on an invalid shape
 *         argument, or SDL_NONSHAPEABLE_WINDOW if the SDL_Window given does
 *         not reference a valid shaped window.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_WindowShapeMode
 * \sa SDL_GetShapedWindowMode
 */
extern DECLSPEC int SDLCALL SDL_SetWindowShape(SDL_Window *window,SDL_Surface *shape,SDL_WindowShapeMode *shape_mode);

/**
 * Get the shape parameters of a shaped window.
 *
 * \param window The shaped window whose parameters should be retrieved.
 * \param shape_mode An empty shape-mode structure to fill, or NULL to check
 *                   whether the window has a shape.
 * \return 0 if the window has a shape and, provided shape_mode was not NULL,
 *         shape_mode has been filled with the mode data,
 *         SDL_NONSHAPEABLE_WINDOW if the SDL_Window given is not a shaped
 *         window, or SDL_WINDOW_LACKS_SHAPE if the SDL_Window given is a
 *         shapeable window currently lacking a shape.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_WindowShapeMode
 * \sa SDL_SetWindowShape
 */
extern DECLSPEC int SDLCALL SDL_GetShapedWindowMode(SDL_Window *window,SDL_WindowShapeMode *shape_mode);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_shape_h_ */
