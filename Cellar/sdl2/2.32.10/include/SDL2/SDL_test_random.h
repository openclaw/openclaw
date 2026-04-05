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

/*
 *  \file SDL_test_random.h
 *
 *  Include file for SDL test framework.
 *
 *  This code is a part of the SDL2_test library, not the main SDL library.
 */

/*

 A "32-bit Multiply with carry random number generator. Very fast.
 Includes a list of recommended multipliers.

 multiply-with-carry generator: x(n) = a*x(n-1) + carry mod 2^32.
 period: (a*2^31)-1

*/

#ifndef SDL_test_random_h_
#define SDL_test_random_h_

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/* --- Definitions */

/*
 * Macros that return a random number in a specific format.
 */
#define SDLTest_RandomInt(c)        ((int)SDLTest_Random(c))

/*
 * Context structure for the random number generator state.
 */
  typedef struct {
    unsigned int a;
    unsigned int x;
    unsigned int c;
    unsigned int ah;
    unsigned int al;
  } SDLTest_RandomContext;


/* --- Function prototypes */

/*
 *  \brief Initialize random number generator with two integers.
 *
 *  Note: The random sequence of numbers returned by ...Random() is the
 *  same for the same two integers and has a period of 2^31.
 *
 *  \param rndContext     pointer to context structure
 *  \param xi         integer that defines the random sequence
 *  \param ci         integer that defines the random sequence
 *
 */
 void SDLTest_RandomInit(SDLTest_RandomContext * rndContext, unsigned int xi,
                  unsigned int ci);

/*
 *  \brief Initialize random number generator based on current system time.
 *
 *  \param rndContext     pointer to context structure
 *
 */
 void SDLTest_RandomInitTime(SDLTest_RandomContext *rndContext);


/*
 *  \brief Initialize random number generator based on current system time.
 *
 *  Note: ...RandomInit() or ...RandomInitTime() must have been called
 *  before using this function.
 *
 *  \param rndContext     pointer to context structure
 *
 *  \returns a random number (32bit unsigned integer)
 *
 */
 unsigned int SDLTest_Random(SDLTest_RandomContext *rndContext);


/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_test_random_h_ */

/* vi: set ts=4 sw=4 expandtab: */
