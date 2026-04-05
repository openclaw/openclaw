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
 * # CategoryKeyboard
 *
 * Include file for SDL keyboard event handling
 */

#ifndef SDL_keyboard_h_
#define SDL_keyboard_h_

#include "SDL_stdinc.h"
#include "SDL_error.h"
#include "SDL_keycode.h"
#include "SDL_video.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/**
 * The SDL keysym structure, used in key events.
 *
 * If you are looking for translated character input, see the SDL_TEXTINPUT
 * event.
 */
typedef struct SDL_Keysym
{
    SDL_Scancode scancode;      /**< SDL physical key code - see SDL_Scancode for details */
    SDL_Keycode sym;            /**< SDL virtual key code - see SDL_Keycode for details */
    Uint16 mod;                 /**< current key modifiers - see SDL_Keymod for details */
    Uint32 unused;
} SDL_Keysym;

/* Function prototypes */

/**
 * Query the window which currently has keyboard focus.
 *
 * \returns the window with keyboard focus.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC SDL_Window * SDLCALL SDL_GetKeyboardFocus(void);

/**
 * Get a snapshot of the current state of the keyboard.
 *
 * The pointer returned is a pointer to an internal SDL array. It will be
 * valid for the whole lifetime of the application and should not be freed by
 * the caller.
 *
 * A array element with a value of 1 means that the key is pressed and a value
 * of 0 means that it is not. Indexes into this array are obtained by using
 * SDL_Scancode values.
 *
 * Use SDL_PumpEvents() to update the state array.
 *
 * This function gives you the current state after all events have been
 * processed, so if a key or button has been pressed and released before you
 * process events, then the pressed state will never show up in the
 * SDL_GetKeyboardState() calls.
 *
 * Note: This function doesn't take into account whether shift has been
 * pressed or not.
 *
 * \param numkeys if non-NULL, receives the length of the returned array.
 * \returns a pointer to an array of key states.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_PumpEvents
 * \sa SDL_ResetKeyboard
 */
extern DECLSPEC const Uint8 *SDLCALL SDL_GetKeyboardState(int *numkeys);

/**
 * Clear the state of the keyboard
 *
 * This function will generate key up events for all pressed keys.
 *
 * \since This function is available since SDL 2.24.0.
 *
 * \sa SDL_GetKeyboardState
 */
extern DECLSPEC void SDLCALL SDL_ResetKeyboard(void);

/**
 * Get the current key modifier state for the keyboard.
 *
 * \returns an OR'd combination of the modifier keys for the keyboard. See
 *          SDL_Keymod for details.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetKeyboardState
 * \sa SDL_SetModState
 */
extern DECLSPEC SDL_Keymod SDLCALL SDL_GetModState(void);

/**
 * Set the current key modifier state for the keyboard.
 *
 * The inverse of SDL_GetModState(), SDL_SetModState() allows you to impose
 * modifier key states on your application. Simply pass your desired modifier
 * states into `modstate`. This value may be a bitwise, OR'd combination of
 * SDL_Keymod values.
 *
 * This does not change the keyboard state, only the key modifier flags that
 * SDL reports.
 *
 * \param modstate the desired SDL_Keymod for the keyboard.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetModState
 */
extern DECLSPEC void SDLCALL SDL_SetModState(SDL_Keymod modstate);

/**
 * Get the key code corresponding to the given scancode according to the
 * current keyboard layout.
 *
 * See SDL_Keycode for details.
 *
 * \param scancode the desired SDL_Scancode to query.
 * \returns the SDL_Keycode that corresponds to the given SDL_Scancode.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetKeyName
 * \sa SDL_GetScancodeFromKey
 */
extern DECLSPEC SDL_Keycode SDLCALL SDL_GetKeyFromScancode(SDL_Scancode scancode);

/**
 * Get the scancode corresponding to the given key code according to the
 * current keyboard layout.
 *
 * See SDL_Scancode for details.
 *
 * \param key the desired SDL_Keycode to query.
 * \returns the SDL_Scancode that corresponds to the given SDL_Keycode.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetKeyFromScancode
 * \sa SDL_GetScancodeName
 */
extern DECLSPEC SDL_Scancode SDLCALL SDL_GetScancodeFromKey(SDL_Keycode key);

/**
 * Get a human-readable name for a scancode.
 *
 * See SDL_Scancode for details.
 *
 * **Warning**: The returned name is by design not stable across platforms,
 * e.g. the name for `SDL_SCANCODE_LGUI` is "Left GUI" under Linux but "Left
 * Windows" under Microsoft Windows, and some scancodes like
 * `SDL_SCANCODE_NONUSBACKSLASH` don't have any name at all. There are even
 * scancodes that share names, e.g. `SDL_SCANCODE_RETURN` and
 * `SDL_SCANCODE_RETURN2` (both called "Return"). This function is therefore
 * unsuitable for creating a stable cross-platform two-way mapping between
 * strings and scancodes.
 *
 * \param scancode the desired SDL_Scancode to query.
 * \returns a pointer to the name for the scancode. If the scancode doesn't
 *          have a name this function returns an empty string ("").
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetScancodeFromKey
 * \sa SDL_GetScancodeFromName
 */
extern DECLSPEC const char *SDLCALL SDL_GetScancodeName(SDL_Scancode scancode);

/**
 * Get a scancode from a human-readable name.
 *
 * \param name the human-readable scancode name.
 * \returns the SDL_Scancode, or `SDL_SCANCODE_UNKNOWN` if the name wasn't
 *          recognized; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetKeyFromName
 * \sa SDL_GetScancodeFromKey
 * \sa SDL_GetScancodeName
 */
extern DECLSPEC SDL_Scancode SDLCALL SDL_GetScancodeFromName(const char *name);

/**
 * Get a human-readable name for a key.
 *
 * See SDL_Scancode and SDL_Keycode for details.
 *
 * \param key the desired SDL_Keycode to query.
 * \returns a pointer to a UTF-8 string that stays valid at least until the
 *          next call to this function. If you need it around any longer, you
 *          must copy it. If the key doesn't have a name, this function
 *          returns an empty string ("").
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetKeyFromName
 * \sa SDL_GetKeyFromScancode
 * \sa SDL_GetScancodeFromKey
 */
extern DECLSPEC const char *SDLCALL SDL_GetKeyName(SDL_Keycode key);

/**
 * Get a key code from a human-readable name.
 *
 * \param name the human-readable key name.
 * \returns key code, or `SDLK_UNKNOWN` if the name wasn't recognized; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetKeyFromScancode
 * \sa SDL_GetKeyName
 * \sa SDL_GetScancodeFromName
 */
extern DECLSPEC SDL_Keycode SDLCALL SDL_GetKeyFromName(const char *name);

/**
 * Start accepting Unicode text input events.
 *
 * This function will start accepting Unicode text input events in the focused
 * SDL window, and start emitting SDL_TextInputEvent (SDL_TEXTINPUT) and
 * SDL_TextEditingEvent (SDL_TEXTEDITING) events. Please use this function in
 * pair with SDL_StopTextInput().
 *
 * On some platforms using this function activates the screen keyboard.
 *
 * On desktop platforms, SDL_StartTextInput() is implicitly called on SDL
 * video subsystem initialization which will cause SDL_TextInputEvent and
 * SDL_TextEditingEvent to begin emitting.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_SetTextInputRect
 * \sa SDL_StopTextInput
 */
extern DECLSPEC void SDLCALL SDL_StartTextInput(void);

/**
 * Check whether or not Unicode text input events are enabled.
 *
 * \returns SDL_TRUE if text input events are enabled else SDL_FALSE.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_StartTextInput
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IsTextInputActive(void);

/**
 * Stop receiving any text input events.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_StartTextInput
 */
extern DECLSPEC void SDLCALL SDL_StopTextInput(void);

/**
 * Dismiss the composition window/IME without disabling the subsystem.
 *
 * \since This function is available since SDL 2.0.22.
 *
 * \sa SDL_StartTextInput
 * \sa SDL_StopTextInput
 */
extern DECLSPEC void SDLCALL SDL_ClearComposition(void);

/**
 * Returns if an IME Composite or Candidate window is currently shown.
 *
 * \since This function is available since SDL 2.0.22.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IsTextInputShown(void);

/**
 * Set the rectangle used to type Unicode text inputs.
 *
 * Native input methods will place a window with word suggestions near it,
 * without covering the text being inputted.
 *
 * To start text input in a given location, this function is intended to be
 * called before SDL_StartTextInput, although some platforms support moving
 * the rectangle even while text input (and a composition) is active.
 *
 * Note: If you want to use the system native IME window, try setting hint
 * **SDL_HINT_IME_SHOW_UI** to **1**, otherwise this function won't give you
 * any feedback.
 *
 * \param rect the SDL_Rect structure representing the rectangle to receive
 *             text (ignored if NULL).
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_StartTextInput
 */
extern DECLSPEC void SDLCALL SDL_SetTextInputRect(const SDL_Rect *rect);

/**
 * Check whether the platform has screen keyboard support.
 *
 * \returns SDL_TRUE if the platform has some screen keyboard support or
 *          SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_StartTextInput
 * \sa SDL_IsScreenKeyboardShown
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasScreenKeyboardSupport(void);

/**
 * Check whether the screen keyboard is shown for given window.
 *
 * \param window the window for which screen keyboard should be queried.
 * \returns SDL_TRUE if screen keyboard is shown or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HasScreenKeyboardSupport
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IsScreenKeyboardShown(SDL_Window *window);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_keyboard_h_ */

/* vi: set ts=4 sw=4 expandtab: */
