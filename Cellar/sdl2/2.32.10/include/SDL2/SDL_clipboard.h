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
 * # CategoryClipboard
 *
 * Include file for SDL clipboard handling
 */

#ifndef SDL_clipboard_h_
#define SDL_clipboard_h_

#include "SDL_stdinc.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/* Function prototypes */

/**
 * Put UTF-8 text into the clipboard.
 *
 * \param text the text to store in the clipboard.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetClipboardText
 * \sa SDL_HasClipboardText
 */
extern DECLSPEC int SDLCALL SDL_SetClipboardText(const char *text);

/**
 * Get UTF-8 text from the clipboard, which must be freed with SDL_free().
 *
 * This functions returns empty string if there was not enough memory left for
 * a copy of the clipboard's content.
 *
 * \returns the clipboard text on success or an empty string on failure; call
 *          SDL_GetError() for more information. Caller must call SDL_free()
 *          on the returned pointer when done with it (even if there was an
 *          error).
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HasClipboardText
 * \sa SDL_SetClipboardText
 */
extern DECLSPEC char * SDLCALL SDL_GetClipboardText(void);

/**
 * Query whether the clipboard exists and contains a non-empty text string.
 *
 * \returns SDL_TRUE if the clipboard has text, or SDL_FALSE if it does not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetClipboardText
 * \sa SDL_SetClipboardText
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasClipboardText(void);

/**
 * Put UTF-8 text into the primary selection.
 *
 * \param text the text to store in the primary selection.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.26.0.
 *
 * \sa SDL_GetPrimarySelectionText
 * \sa SDL_HasPrimarySelectionText
 */
extern DECLSPEC int SDLCALL SDL_SetPrimarySelectionText(const char *text);

/**
 * Get UTF-8 text from the primary selection, which must be freed with
 * SDL_free().
 *
 * This functions returns empty string if there was not enough memory left for
 * a copy of the primary selection's content.
 *
 * \returns the primary selection text on success or an empty string on
 *          failure; call SDL_GetError() for more information. Caller must
 *          call SDL_free() on the returned pointer when done with it (even if
 *          there was an error).
 *
 * \since This function is available since SDL 2.26.0.
 *
 * \sa SDL_HasPrimarySelectionText
 * \sa SDL_SetPrimarySelectionText
 */
extern DECLSPEC char * SDLCALL SDL_GetPrimarySelectionText(void);

/**
 * Query whether the primary selection exists and contains a non-empty text
 * string.
 *
 * \returns SDL_TRUE if the primary selection has text, or SDL_FALSE if it
 *          does not.
 *
 * \since This function is available since SDL 2.26.0.
 *
 * \sa SDL_GetPrimarySelectionText
 * \sa SDL_SetPrimarySelectionText
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasPrimarySelectionText(void);


/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_clipboard_h_ */

/* vi: set ts=4 sw=4 expandtab: */
