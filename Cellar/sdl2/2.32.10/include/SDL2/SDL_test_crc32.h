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
 *  \file SDL_test_crc32.h
 *
 *  Include file for SDL test framework.
 *
 *  This code is a part of the SDL2_test library, not the main SDL library.
 */

/*

 Implements CRC32 calculations (default output is Perl String::CRC32 compatible).

*/

#ifndef SDL_test_crc32_h_
#define SDL_test_crc32_h_

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif


/* ------------ Definitions --------- */

/* Definition shared by all CRC routines */

#ifndef CrcUint32
 #define CrcUint32  unsigned int
#endif
#ifndef CrcUint8
 #define CrcUint8   unsigned char
#endif

#ifdef ORIGINAL_METHOD
 #define CRC32_POLY 0x04c11db7   /* AUTODIN II, Ethernet, & FDDI */
#else
 #define CRC32_POLY 0xEDB88320   /* Perl String::CRC32 compatible */
#endif

/*
 * Data structure for CRC32 (checksum) computation
 */
  typedef struct {
    CrcUint32    crc32_table[256]; /* CRC table */
  } SDLTest_Crc32Context;

/* ---------- Function Prototypes ------------- */

/*
 * \brief Initialize the CRC context
 *
 * Note: The function initializes the crc table required for all crc calculations.
 *
 * \param crcContext        pointer to context variable
 *
 * \returns 0 for OK, -1 on error
 *
 */
 int SDLTest_Crc32Init(SDLTest_Crc32Context * crcContext);


/*
 * \brief calculate a crc32 from a data block
 *
 * \param crcContext         pointer to context variable
 * \param inBuf              input buffer to checksum
 * \param inLen              length of input buffer
 * \param crc32              pointer to Uint32 to store the final CRC into
 *
 * \returns 0 for OK, -1 on error
 *
 */
int SDLTest_Crc32Calc(SDLTest_Crc32Context * crcContext, CrcUint8 *inBuf, CrcUint32 inLen, CrcUint32 *crc32);

/* Same routine broken down into three steps */
int SDLTest_Crc32CalcStart(SDLTest_Crc32Context * crcContext, CrcUint32 *crc32);
int SDLTest_Crc32CalcEnd(SDLTest_Crc32Context * crcContext, CrcUint32 *crc32);
int SDLTest_Crc32CalcBuffer(SDLTest_Crc32Context * crcContext, CrcUint8 *inBuf, CrcUint32 inLen, CrcUint32 *crc32);


/*
 * \brief clean up CRC context
 *
 * \param crcContext        pointer to context variable
 *
 * \returns 0 for OK, -1 on error
 *
*/

int SDLTest_Crc32Done(SDLTest_Crc32Context * crcContext);


/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_test_crc32_h_ */

/* vi: set ts=4 sw=4 expandtab: */
