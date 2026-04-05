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
 * # CategoryMouse
 *
 * Include file for SDL mouse event handling.
 */

#ifndef SDL_mouse_h_
#define SDL_mouse_h_

#include "SDL_stdinc.h"
#include "SDL_error.h"
#include "SDL_video.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

typedef struct SDL_Cursor SDL_Cursor;   /**< Implementation dependent */

/**
 * Cursor types for SDL_CreateSystemCursor().
 */
typedef enum SDL_SystemCursor
{
    SDL_SYSTEM_CURSOR_ARROW,     /**< Arrow */
    SDL_SYSTEM_CURSOR_IBEAM,     /**< I-beam */
    SDL_SYSTEM_CURSOR_WAIT,      /**< Wait */
    SDL_SYSTEM_CURSOR_CROSSHAIR, /**< Crosshair */
    SDL_SYSTEM_CURSOR_WAITARROW, /**< Small wait cursor (or Wait if not available) */
    SDL_SYSTEM_CURSOR_SIZENWSE,  /**< Double arrow pointing northwest and southeast */
    SDL_SYSTEM_CURSOR_SIZENESW,  /**< Double arrow pointing northeast and southwest */
    SDL_SYSTEM_CURSOR_SIZEWE,    /**< Double arrow pointing west and east */
    SDL_SYSTEM_CURSOR_SIZENS,    /**< Double arrow pointing north and south */
    SDL_SYSTEM_CURSOR_SIZEALL,   /**< Four pointed arrow pointing north, south, east, and west */
    SDL_SYSTEM_CURSOR_NO,        /**< Slashed circle or crossbones */
    SDL_SYSTEM_CURSOR_HAND,      /**< Hand */
    SDL_NUM_SYSTEM_CURSORS
} SDL_SystemCursor;

/**
 * Scroll direction types for the Scroll event
 */
typedef enum SDL_MouseWheelDirection
{
    SDL_MOUSEWHEEL_NORMAL,    /**< The scroll direction is normal */
    SDL_MOUSEWHEEL_FLIPPED    /**< The scroll direction is flipped / natural */
} SDL_MouseWheelDirection;

/* Function prototypes */

/**
 * Get the window which currently has mouse focus.
 *
 * \returns the window with mouse focus.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC SDL_Window * SDLCALL SDL_GetMouseFocus(void);

/**
 * Retrieve the current state of the mouse.
 *
 * The current button state is returned as a button bitmask, which can be
 * tested using the `SDL_BUTTON(X)` macros (where `X` is generally 1 for the
 * left, 2 for middle, 3 for the right button), and `x` and `y` are set to the
 * mouse cursor position relative to the focus window. You can pass NULL for
 * either `x` or `y`.
 *
 * \param x the x coordinate of the mouse cursor position relative to the
 *          focus window.
 * \param y the y coordinate of the mouse cursor position relative to the
 *          focus window.
 * \returns a 32-bit button bitmask of the current button state.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetGlobalMouseState
 * \sa SDL_GetRelativeMouseState
 * \sa SDL_PumpEvents
 */
extern DECLSPEC Uint32 SDLCALL SDL_GetMouseState(int *x, int *y);

/**
 * Get the current state of the mouse in relation to the desktop.
 *
 * This works similarly to SDL_GetMouseState(), but the coordinates will be
 * reported relative to the top-left of the desktop. This can be useful if you
 * need to track the mouse outside of a specific window and SDL_CaptureMouse()
 * doesn't fit your needs. For example, it could be useful if you need to
 * track the mouse while dragging a window, where coordinates relative to a
 * window might not be in sync at all times.
 *
 * Note: SDL_GetMouseState() returns the mouse position as SDL understands it
 * from the last pump of the event queue. This function, however, queries the
 * OS for the current mouse position, and as such, might be a slightly less
 * efficient function. Unless you know what you're doing and have a good
 * reason to use this function, you probably want SDL_GetMouseState() instead.
 *
 * \param x filled in with the current X coord relative to the desktop; can be
 *          NULL.
 * \param y filled in with the current Y coord relative to the desktop; can be
 *          NULL.
 * \returns the current button state as a bitmask which can be tested using
 *          the SDL_BUTTON(X) macros.
 *
 * \since This function is available since SDL 2.0.4.
 *
 * \sa SDL_CaptureMouse
 */
extern DECLSPEC Uint32 SDLCALL SDL_GetGlobalMouseState(int *x, int *y);

/**
 * Retrieve the relative state of the mouse.
 *
 * The current button state is returned as a button bitmask, which can be
 * tested using the `SDL_BUTTON(X)` macros (where `X` is generally 1 for the
 * left, 2 for middle, 3 for the right button), and `x` and `y` are set to the
 * mouse deltas since the last call to SDL_GetRelativeMouseState() or since
 * event initialization. You can pass NULL for either `x` or `y`.
 *
 * \param x a pointer filled with the last recorded x coordinate of the mouse.
 * \param y a pointer filled with the last recorded y coordinate of the mouse.
 * \returns a 32-bit button bitmask of the relative button state.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetMouseState
 */
extern DECLSPEC Uint32 SDLCALL SDL_GetRelativeMouseState(int *x, int *y);

/**
 * Move the mouse cursor to the given position within the window.
 *
 * This function generates a mouse motion event if relative mode is not
 * enabled. If relative mode is enabled, you can force mouse events for the
 * warp by setting the SDL_HINT_MOUSE_RELATIVE_WARP_MOTION hint.
 *
 * Note that this function will appear to succeed, but not actually move the
 * mouse when used over Microsoft Remote Desktop.
 *
 * \param window the window to move the mouse into, or NULL for the current
 *               mouse focus.
 * \param x the x coordinate within the window.
 * \param y the y coordinate within the window.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_WarpMouseGlobal
 */
extern DECLSPEC void SDLCALL SDL_WarpMouseInWindow(SDL_Window * window,
                                                   int x, int y);

/**
 * Move the mouse to the given position in global screen space.
 *
 * This function generates a mouse motion event.
 *
 * A failure of this function usually means that it is unsupported by a
 * platform.
 *
 * Note that this function will appear to succeed, but not actually move the
 * mouse when used over Microsoft Remote Desktop.
 *
 * \param x the x coordinate.
 * \param y the y coordinate.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.4.
 *
 * \sa SDL_WarpMouseInWindow
 */
extern DECLSPEC int SDLCALL SDL_WarpMouseGlobal(int x, int y);

/**
 * Set relative mouse mode.
 *
 * While the mouse is in relative mode, the cursor is hidden, the mouse
 * position is constrained to the window, and SDL will report continuous
 * relative mouse motion even if the mouse is at the edge of the window.
 *
 * This function will flush any pending mouse motion.
 *
 * \param enabled SDL_TRUE to enable relative mode, SDL_FALSE to disable.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 *          If relative mode is not supported, this returns -1.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetRelativeMouseMode
 */
extern DECLSPEC int SDLCALL SDL_SetRelativeMouseMode(SDL_bool enabled);

/**
 * Capture the mouse and to track input outside an SDL window.
 *
 * Capturing enables your app to obtain mouse events globally, instead of just
 * within your window. Not all video targets support this function. When
 * capturing is enabled, the current window will get all mouse events, but
 * unlike relative mode, no change is made to the cursor and it is not
 * restrained to your window.
 *
 * This function may also deny mouse input to other windows--both those in
 * your application and others on the system--so you should use this function
 * sparingly, and in small bursts. For example, you might want to track the
 * mouse while the user is dragging something, until the user releases a mouse
 * button. It is not recommended that you capture the mouse for long periods
 * of time, such as the entire time your app is running. For that, you should
 * probably use SDL_SetRelativeMouseMode() or SDL_SetWindowGrab(), depending
 * on your goals.
 *
 * While captured, mouse events still report coordinates relative to the
 * current (foreground) window, but those coordinates may be outside the
 * bounds of the window (including negative values). Capturing is only allowed
 * for the foreground window. If the window loses focus while capturing, the
 * capture will be disabled automatically.
 *
 * While capturing is enabled, the current window will have the
 * `SDL_WINDOW_MOUSE_CAPTURE` flag set.
 *
 * Please note that as of SDL 2.0.22, SDL will attempt to "auto capture" the
 * mouse while the user is pressing a button; this is to try and make mouse
 * behavior more consistent between platforms, and deal with the common case
 * of a user dragging the mouse outside of the window. This means that if you
 * are calling SDL_CaptureMouse() only to deal with this situation, you no
 * longer have to (although it is safe to do so). If this causes problems for
 * your app, you can disable auto capture by setting the
 * `SDL_HINT_MOUSE_AUTO_CAPTURE` hint to zero.
 *
 * \param enabled SDL_TRUE to enable capturing, SDL_FALSE to disable.
 * \returns 0 on success or -1 if not supported; call SDL_GetError() for more
 *          information.
 *
 * \since This function is available since SDL 2.0.4.
 *
 * \sa SDL_GetGlobalMouseState
 */
extern DECLSPEC int SDLCALL SDL_CaptureMouse(SDL_bool enabled);

/**
 * Query whether relative mouse mode is enabled.
 *
 * \returns SDL_TRUE if relative mode is enabled or SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_SetRelativeMouseMode
 */
extern DECLSPEC SDL_bool SDLCALL SDL_GetRelativeMouseMode(void);

/**
 * Create a cursor using the specified bitmap data and mask (in MSB format).
 *
 * `mask` has to be in MSB (Most Significant Bit) format.
 *
 * The cursor width (`w`) must be a multiple of 8 bits.
 *
 * The cursor is created in black and white according to the following:
 *
 * - data=0, mask=1: white
 * - data=1, mask=1: black
 * - data=0, mask=0: transparent
 * - data=1, mask=0: inverted color if possible, black if not.
 *
 * Cursors created with this function must be freed with SDL_FreeCursor().
 *
 * If you want to have a color cursor, or create your cursor from an
 * SDL_Surface, you should use SDL_CreateColorCursor(). Alternately, you can
 * hide the cursor and draw your own as part of your game's rendering, but it
 * will be bound to the framerate.
 *
 * Also, since SDL 2.0.0, SDL_CreateSystemCursor() is available, which
 * provides twelve readily available system cursors to pick from.
 *
 * \param data the color value for each pixel of the cursor.
 * \param mask the mask value for each pixel of the cursor.
 * \param w the width of the cursor.
 * \param h the height of the cursor.
 * \param hot_x the X-axis location of the upper left corner of the cursor
 *              relative to the actual mouse position.
 * \param hot_y the Y-axis location of the upper left corner of the cursor
 *              relative to the actual mouse position.
 * \returns a new cursor with the specified parameters on success or NULL on
 *          failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_FreeCursor
 * \sa SDL_SetCursor
 * \sa SDL_ShowCursor
 */
extern DECLSPEC SDL_Cursor *SDLCALL SDL_CreateCursor(const Uint8 * data,
                                                     const Uint8 * mask,
                                                     int w, int h, int hot_x,
                                                     int hot_y);

/**
 * Create a color cursor.
 *
 * \param surface an SDL_Surface structure representing the cursor image.
 * \param hot_x the x position of the cursor hot spot.
 * \param hot_y the y position of the cursor hot spot.
 * \returns the new cursor on success or NULL on failure; call SDL_GetError()
 *          for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_CreateCursor
 * \sa SDL_FreeCursor
 */
extern DECLSPEC SDL_Cursor *SDLCALL SDL_CreateColorCursor(SDL_Surface *surface,
                                                          int hot_x,
                                                          int hot_y);

/**
 * Create a system cursor.
 *
 * \param id an SDL_SystemCursor enum value.
 * \returns a cursor on success or NULL on failure; call SDL_GetError() for
 *          more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_FreeCursor
 */
extern DECLSPEC SDL_Cursor *SDLCALL SDL_CreateSystemCursor(SDL_SystemCursor id);

/**
 * Set the active cursor.
 *
 * This function sets the currently active cursor to the specified one. If the
 * cursor is currently visible, the change will be immediately represented on
 * the display. SDL_SetCursor(NULL) can be used to force cursor redraw, if
 * this is desired for any reason.
 *
 * \param cursor a cursor to make active.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_CreateCursor
 * \sa SDL_GetCursor
 * \sa SDL_ShowCursor
 */
extern DECLSPEC void SDLCALL SDL_SetCursor(SDL_Cursor * cursor);

/**
 * Get the active cursor.
 *
 * This function returns a pointer to the current cursor which is owned by the
 * library. It is not necessary to free the cursor with SDL_FreeCursor().
 *
 * \returns the active cursor or NULL if there is no mouse.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_SetCursor
 */
extern DECLSPEC SDL_Cursor *SDLCALL SDL_GetCursor(void);

/**
 * Get the default cursor.
 *
 * You do not have to call SDL_FreeCursor() on the return value, but it is
 * safe to do so.
 *
 * \returns the default cursor on success or NULL on failure.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_CreateSystemCursor
 */
extern DECLSPEC SDL_Cursor *SDLCALL SDL_GetDefaultCursor(void);

/**
 * Free a previously-created cursor.
 *
 * Use this function to free cursor resources created with SDL_CreateCursor(),
 * SDL_CreateColorCursor() or SDL_CreateSystemCursor().
 *
 * \param cursor the cursor to free.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_CreateColorCursor
 * \sa SDL_CreateCursor
 * \sa SDL_CreateSystemCursor
 */
extern DECLSPEC void SDLCALL SDL_FreeCursor(SDL_Cursor * cursor);

/**
 * Toggle whether or not the cursor is shown.
 *
 * The cursor starts off displayed but can be turned off. Passing `SDL_ENABLE`
 * displays the cursor and passing `SDL_DISABLE` hides it.
 *
 * The current state of the mouse cursor can be queried by passing
 * `SDL_QUERY`; either `SDL_DISABLE` or `SDL_ENABLE` will be returned.
 *
 * \param toggle `SDL_ENABLE` to show the cursor, `SDL_DISABLE` to hide it,
 *               `SDL_QUERY` to query the current state without changing it.
 * \returns `SDL_ENABLE` if the cursor is shown, or `SDL_DISABLE` if the
 *          cursor is hidden, or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_CreateCursor
 * \sa SDL_SetCursor
 */
extern DECLSPEC int SDLCALL SDL_ShowCursor(int toggle);

/**
 * Used as a mask when testing buttons in buttonstate.
 *
 * - Button 1: Left mouse button
 * - Button 2: Middle mouse button
 * - Button 3: Right mouse button
 */
#define SDL_BUTTON(X)       (1 << ((X)-1))
#define SDL_BUTTON_LEFT     1
#define SDL_BUTTON_MIDDLE   2
#define SDL_BUTTON_RIGHT    3
#define SDL_BUTTON_X1       4
#define SDL_BUTTON_X2       5
#define SDL_BUTTON_LMASK    SDL_BUTTON(SDL_BUTTON_LEFT)
#define SDL_BUTTON_MMASK    SDL_BUTTON(SDL_BUTTON_MIDDLE)
#define SDL_BUTTON_RMASK    SDL_BUTTON(SDL_BUTTON_RIGHT)
#define SDL_BUTTON_X1MASK   SDL_BUTTON(SDL_BUTTON_X1)
#define SDL_BUTTON_X2MASK   SDL_BUTTON(SDL_BUTTON_X2)

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_mouse_h_ */

/* vi: set ts=4 sw=4 expandtab: */
