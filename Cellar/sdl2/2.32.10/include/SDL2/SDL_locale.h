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
 * # CategoryLocale
 *
 * Include file for SDL locale services
 */

#ifndef _SDL_locale_h
#define _SDL_locale_h

#include "SDL_stdinc.h"
#include "SDL_error.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
/* *INDENT-OFF* */
extern "C" {
/* *INDENT-ON* */
#endif


typedef struct SDL_Locale
{
    const char *language;  /**< A language name, like "en" for English. */
    const char *country;  /**< A country, like "US" for America. Can be NULL. */
} SDL_Locale;

/**
 * Report the user's preferred locale.
 *
 * This returns an array of SDL_Locale structs, the final item zeroed out.
 * When the caller is done with this array, it should call SDL_free() on the
 * returned value; all the memory involved is allocated in a single block, so
 * a single SDL_free() will suffice.
 *
 * Returned language strings are in the format xx, where 'xx' is an ISO-639
 * language specifier (such as "en" for English, "de" for German, etc).
 * Country strings are in the format YY, where "YY" is an ISO-3166 country
 * code (such as "US" for the United States, "CA" for Canada, etc). Country
 * might be NULL if there's no specific guidance on them (so you might get {
 * "en", "US" } for American English, but { "en", NULL } means "English
 * language, generically"). Language strings are never NULL, except to
 * terminate the array.
 *
 * Please note that not all of these strings are 2 characters; some are three
 * or more.
 *
 * The returned list of locales are in the order of the user's preference. For
 * example, a German citizen that is fluent in US English and knows enough
 * Japanese to navigate around Tokyo might have a list like: { "de", "en_US",
 * "jp", NULL }. Someone from England might prefer British English (where
 * "color" is spelled "colour", etc), but will settle for anything like it: {
 * "en_GB", "en", NULL }.
 *
 * This function returns NULL on error, including when the platform does not
 * supply this information at all.
 *
 * This might be a "slow" call that has to query the operating system. It's
 * best to ask for this once and save the results. However, this list can
 * change, usually because the user has changed a system preference outside of
 * your program; SDL will send an SDL_LOCALECHANGED event in this case, if
 * possible, and you can call this function again to get an updated copy of
 * preferred locales.
 *
 * \return array of locales, terminated with a locale with a NULL language
 *         field. Will return NULL on error.
 *
 * \since This function is available since SDL 2.0.14.
 */
extern DECLSPEC SDL_Locale * SDLCALL SDL_GetPreferredLocales(void);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
/* *INDENT-OFF* */
}
/* *INDENT-ON* */
#endif
#include "close_code.h"

#endif /* _SDL_locale_h */

/* vi: set ts=4 sw=4 expandtab: */
