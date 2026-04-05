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
 *  \file SDL_test_fuzzer.h
 *
 *  Include file for SDL test framework.
 *
 *  This code is a part of the SDL2_test library, not the main SDL library.
 */

/*

  Data generators for fuzzing test data in a reproducible way.

*/

#ifndef SDL_test_fuzzer_h_
#define SDL_test_fuzzer_h_

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif


/*
  Based on GSOC code by Markus Kauppila <markus.kauppila@gmail.com>
*/


/*
 * \file
 * Note: The fuzzer implementation uses a static instance of random context
 * internally which makes it thread-UNsafe.
 */

/*
 * Initializes the fuzzer for a test
 *
 * \param execKey Execution "Key" that initializes the random number generator uniquely for the test.
 *
 */
void SDLTest_FuzzerInit(Uint64 execKey);


/*
 * Returns a random Uint8
 *
 * \returns a generated integer
 */
Uint8 SDLTest_RandomUint8(void);

/*
 * Returns a random Sint8
 *
 * \returns a generated signed integer
 */
Sint8 SDLTest_RandomSint8(void);


/*
 * Returns a random Uint16
 *
 * \returns a generated integer
 */
Uint16 SDLTest_RandomUint16(void);

/*
 * Returns a random Sint16
 *
 * \returns a generated signed integer
 */
Sint16 SDLTest_RandomSint16(void);


/*
 * Returns a random integer
 *
 * \returns a generated integer
 */
Sint32 SDLTest_RandomSint32(void);


/*
 * Returns a random positive integer
 *
 * \returns a generated integer
 */
Uint32 SDLTest_RandomUint32(void);

/*
 * Returns random Uint64.
 *
 * \returns a generated integer
 */
Uint64 SDLTest_RandomUint64(void);


/*
 * Returns random Sint64.
 *
 * \returns a generated signed integer
 */
Sint64 SDLTest_RandomSint64(void);

/*
 * \returns a random float in range [0.0 - 1.0]
 */
float SDLTest_RandomUnitFloat(void);

/*
 * \returns a random double in range [0.0 - 1.0]
 */
double SDLTest_RandomUnitDouble(void);

/*
 * \returns a random float.
 *
 */
float SDLTest_RandomFloat(void);

/*
 * \returns a random double.
 *
 */
double SDLTest_RandomDouble(void);

/*
 * Returns a random boundary value for Uint8 within the given boundaries.
 * Boundaries are inclusive, see the usage examples below. If validDomain
 * is true, the function will only return valid boundaries, otherwise non-valid
 * boundaries are also possible.
 * If boundary1 > boundary2, the values are swapped
 *
 * Usage examples:
 * RandomUint8BoundaryValue(10, 20, SDL_TRUE) returns 10, 11, 19 or 20
 * RandomUint8BoundaryValue(1, 20, SDL_FALSE) returns 0 or 21
 * RandomUint8BoundaryValue(0, 99, SDL_FALSE) returns 100
 * RandomUint8BoundaryValue(0, 255, SDL_FALSE) returns 0 (error set)
 *
 * \param boundary1 Lower boundary limit
 * \param boundary2 Upper boundary limit
 * \param validDomain Should the generated boundary be valid (=within the bounds) or not?
 *
 * \returns a random boundary value for the given range and domain or 0 with error set
 */
Uint8 SDLTest_RandomUint8BoundaryValue(Uint8 boundary1, Uint8 boundary2, SDL_bool validDomain);

/*
 * Returns a random boundary value for Uint16 within the given boundaries.
 * Boundaries are inclusive, see the usage examples below. If validDomain
 * is true, the function will only return valid boundaries, otherwise non-valid
 * boundaries are also possible.
 * If boundary1 > boundary2, the values are swapped
 *
 * Usage examples:
 * RandomUint16BoundaryValue(10, 20, SDL_TRUE) returns 10, 11, 19 or 20
 * RandomUint16BoundaryValue(1, 20, SDL_FALSE) returns 0 or 21
 * RandomUint16BoundaryValue(0, 99, SDL_FALSE) returns 100
 * RandomUint16BoundaryValue(0, 0xFFFF, SDL_FALSE) returns 0 (error set)
 *
 * \param boundary1 Lower boundary limit
 * \param boundary2 Upper boundary limit
 * \param validDomain Should the generated boundary be valid (=within the bounds) or not?
 *
 * \returns a random boundary value for the given range and domain or 0 with error set
 */
Uint16 SDLTest_RandomUint16BoundaryValue(Uint16 boundary1, Uint16 boundary2, SDL_bool validDomain);

/*
 * Returns a random boundary value for Uint32 within the given boundaries.
 * Boundaries are inclusive, see the usage examples below. If validDomain
 * is true, the function will only return valid boundaries, otherwise non-valid
 * boundaries are also possible.
 * If boundary1 > boundary2, the values are swapped
 *
 * Usage examples:
 * RandomUint32BoundaryValue(10, 20, SDL_TRUE) returns 10, 11, 19 or 20
 * RandomUint32BoundaryValue(1, 20, SDL_FALSE) returns 0 or 21
 * RandomUint32BoundaryValue(0, 99, SDL_FALSE) returns 100
 * RandomUint32BoundaryValue(0, 0xFFFFFFFF, SDL_FALSE) returns 0 (with error set)
 *
 * \param boundary1 Lower boundary limit
 * \param boundary2 Upper boundary limit
 * \param validDomain Should the generated boundary be valid (=within the bounds) or not?
 *
 * \returns a random boundary value for the given range and domain or 0 with error set
 */
Uint32 SDLTest_RandomUint32BoundaryValue(Uint32 boundary1, Uint32 boundary2, SDL_bool validDomain);

/*
 * Returns a random boundary value for Uint64 within the given boundaries.
 * Boundaries are inclusive, see the usage examples below. If validDomain
 * is true, the function will only return valid boundaries, otherwise non-valid
 * boundaries are also possible.
 * If boundary1 > boundary2, the values are swapped
 *
 * Usage examples:
 * RandomUint64BoundaryValue(10, 20, SDL_TRUE) returns 10, 11, 19 or 20
 * RandomUint64BoundaryValue(1, 20, SDL_FALSE) returns 0 or 21
 * RandomUint64BoundaryValue(0, 99, SDL_FALSE) returns 100
 * RandomUint64BoundaryValue(0, 0xFFFFFFFFFFFFFFFF, SDL_FALSE) returns 0 (with error set)
 *
 * \param boundary1 Lower boundary limit
 * \param boundary2 Upper boundary limit
 * \param validDomain Should the generated boundary be valid (=within the bounds) or not?
 *
 * \returns a random boundary value for the given range and domain or 0 with error set
 */
Uint64 SDLTest_RandomUint64BoundaryValue(Uint64 boundary1, Uint64 boundary2, SDL_bool validDomain);

/*
 * Returns a random boundary value for Sint8 within the given boundaries.
 * Boundaries are inclusive, see the usage examples below. If validDomain
 * is true, the function will only return valid boundaries, otherwise non-valid
 * boundaries are also possible.
 * If boundary1 > boundary2, the values are swapped
 *
 * Usage examples:
 * RandomSint8BoundaryValue(-10, 20, SDL_TRUE) returns -11, -10, 19 or 20
 * RandomSint8BoundaryValue(-100, -10, SDL_FALSE) returns -101 or -9
 * RandomSint8BoundaryValue(SINT8_MIN, 99, SDL_FALSE) returns 100
 * RandomSint8BoundaryValue(SINT8_MIN, SINT8_MAX, SDL_FALSE) returns SINT8_MIN (== error value) with error set
 *
 * \param boundary1 Lower boundary limit
 * \param boundary2 Upper boundary limit
 * \param validDomain Should the generated boundary be valid (=within the bounds) or not?
 *
 * \returns a random boundary value for the given range and domain or SINT8_MIN with error set
 */
Sint8 SDLTest_RandomSint8BoundaryValue(Sint8 boundary1, Sint8 boundary2, SDL_bool validDomain);


/*
 * Returns a random boundary value for Sint16 within the given boundaries.
 * Boundaries are inclusive, see the usage examples below. If validDomain
 * is true, the function will only return valid boundaries, otherwise non-valid
 * boundaries are also possible.
 * If boundary1 > boundary2, the values are swapped
 *
 * Usage examples:
 * RandomSint16BoundaryValue(-10, 20, SDL_TRUE) returns -11, -10, 19 or 20
 * RandomSint16BoundaryValue(-100, -10, SDL_FALSE) returns -101 or -9
 * RandomSint16BoundaryValue(SINT16_MIN, 99, SDL_FALSE) returns 100
 * RandomSint16BoundaryValue(SINT16_MIN, SINT16_MAX, SDL_FALSE) returns SINT16_MIN (== error value) with error set
 *
 * \param boundary1 Lower boundary limit
 * \param boundary2 Upper boundary limit
 * \param validDomain Should the generated boundary be valid (=within the bounds) or not?
 *
 * \returns a random boundary value for the given range and domain or SINT16_MIN with error set
 */
Sint16 SDLTest_RandomSint16BoundaryValue(Sint16 boundary1, Sint16 boundary2, SDL_bool validDomain);

/*
 * Returns a random boundary value for Sint32 within the given boundaries.
 * Boundaries are inclusive, see the usage examples below. If validDomain
 * is true, the function will only return valid boundaries, otherwise non-valid
 * boundaries are also possible.
 * If boundary1 > boundary2, the values are swapped
 *
 * Usage examples:
 * RandomSint32BoundaryValue(-10, 20, SDL_TRUE) returns -11, -10, 19 or 20
 * RandomSint32BoundaryValue(-100, -10, SDL_FALSE) returns -101 or -9
 * RandomSint32BoundaryValue(SINT32_MIN, 99, SDL_FALSE) returns 100
 * RandomSint32BoundaryValue(SINT32_MIN, SINT32_MAX, SDL_FALSE) returns SINT32_MIN (== error value)
 *
 * \param boundary1 Lower boundary limit
 * \param boundary2 Upper boundary limit
 * \param validDomain Should the generated boundary be valid (=within the bounds) or not?
 *
 * \returns a random boundary value for the given range and domain or SINT32_MIN with error set
 */
Sint32 SDLTest_RandomSint32BoundaryValue(Sint32 boundary1, Sint32 boundary2, SDL_bool validDomain);

/*
 * Returns a random boundary value for Sint64 within the given boundaries.
 * Boundaries are inclusive, see the usage examples below. If validDomain
 * is true, the function will only return valid boundaries, otherwise non-valid
 * boundaries are also possible.
 * If boundary1 > boundary2, the values are swapped
 *
 * Usage examples:
 * RandomSint64BoundaryValue(-10, 20, SDL_TRUE) returns -11, -10, 19 or 20
 * RandomSint64BoundaryValue(-100, -10, SDL_FALSE) returns -101 or -9
 * RandomSint64BoundaryValue(SINT64_MIN, 99, SDL_FALSE) returns 100
 * RandomSint64BoundaryValue(SINT64_MIN, SINT64_MAX, SDL_FALSE) returns SINT64_MIN (== error value) and error set
 *
 * \param boundary1 Lower boundary limit
 * \param boundary2 Upper boundary limit
 * \param validDomain Should the generated boundary be valid (=within the bounds) or not?
 *
 * \returns a random boundary value for the given range and domain or SINT64_MIN with error set
 */
Sint64 SDLTest_RandomSint64BoundaryValue(Sint64 boundary1, Sint64 boundary2, SDL_bool validDomain);


/*
 * Returns integer in range [min, max] (inclusive).
 * Min and max values can be negative values.
 * If Max in smaller than min, then the values are swapped.
 * Min and max are the same value, that value will be returned.
 *
 * \param min Minimum inclusive value of returned random number
 * \param max Maximum inclusive value of returned random number
 *
 * \returns a generated random integer in range
 */
Sint32 SDLTest_RandomIntegerInRange(Sint32 min, Sint32 max);


/*
 * Generates random null-terminated string. The minimum length for
 * the string is 1 character, maximum length for the string is 255
 * characters and it can contain ASCII characters from 32 to 126.
 *
 * Note: Returned string needs to be deallocated.
 *
 * \returns a newly allocated random string; or NULL if length was invalid or string could not be allocated.
 */
char * SDLTest_RandomAsciiString(void);


/*
 * Generates random null-terminated string. The maximum length for
 * the string is defined by the maxLength parameter.
 * String can contain ASCII characters from 32 to 126.
 *
 * Note: Returned string needs to be deallocated.
 *
 * \param maxLength The maximum length of the generated string.
 *
 * \returns a newly allocated random string; or NULL if maxLength was invalid or string could not be allocated.
 */
char * SDLTest_RandomAsciiStringWithMaximumLength(int maxLength);


/*
 * Generates random null-terminated string. The length for
 * the string is defined by the size parameter.
 * String can contain ASCII characters from 32 to 126.
 *
 * Note: Returned string needs to be deallocated.
 *
 * \param size The length of the generated string
 *
 * \returns a newly allocated random string; or NULL if size was invalid or string could not be allocated.
 */
char * SDLTest_RandomAsciiStringOfSize(int size);


/*
 * Get the invocation count for the fuzzer since last ...FuzzerInit.
 *
 * \returns the invocation count.
 */
int SDLTest_GetFuzzerInvocationCount(void);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_test_fuzzer_h_ */

/* vi: set ts=4 sw=4 expandtab: */
