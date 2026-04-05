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
 * # CategoryBits
 *
 * Functions for fiddling with bits and bitmasks.
 */

#ifndef SDL_bits_h_
#define SDL_bits_h_

#include "SDL_stdinc.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/**
 *  \file SDL_bits.h
 */

/**
 *  Get the index of the most significant bit. Result is undefined when called
 *  with 0. This operation can also be stated as "count leading zeroes" and
 *  "log base 2".
 *
 *  \return the index of the most significant bit, or -1 if the value is 0.
 */
#if defined(__WATCOMC__) && defined(__386__)
extern __inline int _SDL_bsr_watcom(Uint32);
#pragma aux _SDL_bsr_watcom = \
    "bsr eax, eax" \
    parm [eax] nomemory \
    value [eax] \
    modify exact [eax] nomemory;
#endif

/**
 * Use this function to get the index of the most significant (set) bit in a
 *
 * \param x the number to find the MSB of.
 * \returns the index of the most significant bit of x, or -1 if x is 0.
 */
SDL_FORCE_INLINE int
SDL_MostSignificantBitIndex32(Uint32 x)
{
#if defined(__GNUC__) && (__GNUC__ >= 4 || (__GNUC__ == 3 && __GNUC_MINOR__ >= 4))
    /* Count Leading Zeroes builtin in GCC.
     * http://gcc.gnu.org/onlinedocs/gcc-4.3.4/gcc/Other-Builtins.html
     */
    if (x == 0) {
        return -1;
    }
    return 31 - __builtin_clz(x);
#elif defined(__WATCOMC__) && defined(__386__)
    if (x == 0) {
        return -1;
    }
    return _SDL_bsr_watcom(x);
#elif defined(_MSC_VER)
    unsigned long index;
    if (_BitScanReverse(&index, x)) {
        return index;
    }
    return -1;
#else
    /* Based off of Bit Twiddling Hacks by Sean Eron Anderson
     * <seander@cs.stanford.edu>, released in the public domain.
     * http://graphics.stanford.edu/~seander/bithacks.html#IntegerLog
     */
    const Uint32 b[] = {0x2, 0xC, 0xF0, 0xFF00, 0xFFFF0000};
    const int    S[] = {1, 2, 4, 8, 16};

    int msbIndex = 0;
    int i;

    if (x == 0) {
        return -1;
    }

    for (i = 4; i >= 0; i--)
    {
        if (x & b[i])
        {
            x >>= S[i];
            msbIndex |= S[i];
        }
    }

    return msbIndex;
#endif
}

SDL_FORCE_INLINE SDL_bool
SDL_HasExactlyOneBitSet32(Uint32 x)
{
    if (x && !(x & (x - 1))) {
        return SDL_TRUE;
    }
    return SDL_FALSE;
}

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_bits_h_ */

/* vi: set ts=4 sw=4 expandtab: */
