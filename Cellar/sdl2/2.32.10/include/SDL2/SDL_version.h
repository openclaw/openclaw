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
 * # CategoryVersion
 *
 * This header defines the current SDL version.
 */

#ifndef SDL_version_h_
#define SDL_version_h_

#include "SDL_stdinc.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/**
 * Information about the version of SDL in use.
 *
 * Represents the library's version as three levels: major revision
 * (increments with massive changes, additions, and enhancements), minor
 * revision (increments with backwards-compatible changes to the major
 * revision), and patchlevel (increments with fixes to the minor revision).
 *
 * \sa SDL_VERSION
 * \sa SDL_GetVersion
 */
typedef struct SDL_version
{
    Uint8 major;        /**< major version */
    Uint8 minor;        /**< minor version */
    Uint8 patch;        /**< update version */
} SDL_version;

/* Printable format: "%d.%d.%d", MAJOR, MINOR, PATCHLEVEL
*/
#define SDL_MAJOR_VERSION   2
#define SDL_MINOR_VERSION   32
#define SDL_PATCHLEVEL      10

/**
 * Macro to determine SDL version program was compiled against.
 *
 * This macro fills in a SDL_version structure with the version of the library
 * you compiled against. This is determined by what header the compiler uses.
 * Note that if you dynamically linked the library, you might have a slightly
 * newer or older version at runtime. That version can be determined with
 * SDL_GetVersion(), which, unlike SDL_VERSION(), is not a macro.
 *
 * \param x A pointer to a SDL_version struct to initialize.
 *
 * \sa SDL_version
 * \sa SDL_GetVersion
 */
#define SDL_VERSION(x)                          \
{                                   \
    (x)->major = SDL_MAJOR_VERSION;                 \
    (x)->minor = SDL_MINOR_VERSION;                 \
    (x)->patch = SDL_PATCHLEVEL;                    \
}

/* TODO: Remove this whole block in SDL 3 */
#if SDL_MAJOR_VERSION < 3

/**
 * This macro turns the version numbers into a numeric value:
 *
 * ```
 * (1,2,3) -> (1203)
 * ```
 *
 * This assumes that there will never be more than 100 patchlevels.
 *
 * In versions higher than 2.9.0, the minor version overflows into the
 * thousands digit: for example, 2.23.0 is encoded as 4300, and 2.255.99 would
 * be encoded as 25799.
 *
 * This macro will not be available in SDL 3.x.
 */
#define SDL_VERSIONNUM(X, Y, Z)                     \
    ((X)*1000 + (Y)*100 + (Z))

/**
 * This is the version number macro for the current SDL version.
 *
 * In versions higher than 2.9.0, the minor version overflows into the
 * thousands digit: for example, 2.23.0 is encoded as 4300. This macro will
 * not be available in SDL 3.x.
 *
 * Deprecated, use SDL_VERSION_ATLEAST or SDL_VERSION instead.
 */
#define SDL_COMPILEDVERSION \
    SDL_VERSIONNUM(SDL_MAJOR_VERSION, SDL_MINOR_VERSION, SDL_PATCHLEVEL)
#endif /* SDL_MAJOR_VERSION < 3 */

/**
 * This macro will evaluate to true if compiled with SDL at least X.Y.Z.
 */
#define SDL_VERSION_ATLEAST(X, Y, Z) \
    ((SDL_MAJOR_VERSION >= X) && \
     (SDL_MAJOR_VERSION > X || SDL_MINOR_VERSION >= Y) && \
     (SDL_MAJOR_VERSION > X || SDL_MINOR_VERSION > Y || SDL_PATCHLEVEL >= Z))

/**
 * Get the version of SDL that is linked against your program.
 *
 * If you are linking to SDL dynamically, then it is possible that the current
 * version will be different than the version you compiled against. This
 * function returns the current version, while SDL_VERSION() is a macro that
 * tells you what version you compiled with.
 *
 * This function may be called safely at any time, even before SDL_Init().
 *
 * \param ver the SDL_version structure that contains the version information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetRevision
 */
extern DECLSPEC void SDLCALL SDL_GetVersion(SDL_version * ver);

/**
 * Get the code revision of SDL that is linked against your program.
 *
 * This value is the revision of the code you are linked with and may be
 * different from the code you are compiling with, which is found in the
 * constant SDL_REVISION.
 *
 * The revision is arbitrary string (a hash value) uniquely identifying the
 * exact revision of the SDL library in use, and is only useful in comparing
 * against other revisions. It is NOT an incrementing number.
 *
 * If SDL wasn't built from a git repository with the appropriate tools, this
 * will return an empty string.
 *
 * Prior to SDL 2.0.16, before development moved to GitHub, this returned a
 * hash for a Mercurial repository.
 *
 * You shouldn't use this function for anything but logging it for debugging
 * purposes. The string is not intended to be reliable in any way.
 *
 * \returns an arbitrary string, uniquely identifying the exact revision of
 *          the SDL library in use.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetVersion
 */
extern DECLSPEC const char *SDLCALL SDL_GetRevision(void);

/**
 * Obsolete function, do not use.
 *
 * When SDL was hosted in a Mercurial repository, and was built carefully,
 * this would return the revision number that the build was created from. This
 * number was not reliable for several reasons, but more importantly, SDL is
 * now hosted in a git repository, which does not offer numbers at all, only
 * hashes. This function only ever returns zero now. Don't use it.
 *
 * Before SDL 2.0.16, this might have returned an unreliable, but non-zero
 * number.
 *
 * \deprecated Use SDL_GetRevision() instead; if SDL was carefully built, it
 *             will return a git hash.
 *
 * \returns zero, always, in modern SDL releases.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetRevision
 */
extern SDL_DEPRECATED DECLSPEC int SDLCALL SDL_GetRevisionNumber(void);


/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_version_h_ */

/* vi: set ts=4 sw=4 expandtab: */
