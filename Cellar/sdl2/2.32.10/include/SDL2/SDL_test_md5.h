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
 *  \file SDL_test_md5.h
 *
 *  Include file for SDL test framework.
 *
 *  This code is a part of the SDL2_test library, not the main SDL library.
 */

/*
 ***********************************************************************
 ** Header file for implementation of MD5                             **
 ** RSA Data Security, Inc. MD5 Message-Digest Algorithm              **
 ** Created: 2/17/90 RLR                                              **
 ** Revised: 12/27/90 SRD,AJ,BSK,JT Reference C version               **
 ** Revised (for MD5): RLR 4/27/91                                    **
 **   -- G modified to have y&~z instead of y&z                       **
 **   -- FF, GG, HH modified to add in last register done             **
 **   -- Access pattern: round 2 works mod 5, round 3 works mod 3     **
 **   -- distinct additive constant for each step                     **
 **   -- round 4 added, working mod 7                                 **
 ***********************************************************************
*/

/*
 ***********************************************************************
 **  Message-digest routines:                                         **
 **  To form the message digest for a message M                       **
 **    (1) Initialize a context buffer mdContext using MD5Init        **
 **    (2) Call MD5Update on mdContext and M                          **
 **    (3) Call MD5Final on mdContext                                 **
 **  The message digest is now in mdContext->digest[0...15]           **
 ***********************************************************************
*/

#ifndef SDL_test_md5_h_
#define SDL_test_md5_h_

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/* ------------ Definitions --------- */

/* typedef a 32-bit type */
  typedef unsigned long int MD5UINT4;

/* Data structure for MD5 (Message-Digest) computation */
  typedef struct {
    MD5UINT4  i[2];     /* number of _bits_ handled mod 2^64 */
    MD5UINT4  buf[4];       /* scratch buffer */
    unsigned char in[64];   /* input buffer */
    unsigned char digest[16];   /* actual digest after Md5Final call */
  } SDLTest_Md5Context;

/* ---------- Function Prototypes ------------- */

/*
 * \brief initialize the context
 *
 * \param  mdContext        pointer to context variable
 *
 * Note: The function initializes the message-digest context
 *       mdContext. Call before each new use of the context -
 *       all fields are set to zero.
 */
 void SDLTest_Md5Init(SDLTest_Md5Context * mdContext);


/*
 * \brief update digest from variable length data
 *
 * \param  mdContext       pointer to context variable
 * \param  inBuf           pointer to data array/string
 * \param  inLen           length of data array/string
 *
 * Note: The function updates the message-digest context to account
 *       for the presence of each of the characters inBuf[0..inLen-1]
 *       in the message whose digest is being computed.
*/

 void SDLTest_Md5Update(SDLTest_Md5Context * mdContext, unsigned char *inBuf,
                 unsigned int inLen);


/*
 * \brief complete digest computation
 *
 * \param mdContext     pointer to context variable
 *
 * Note: The function terminates the message-digest computation and
 *       ends with the desired message digest in mdContext.digest[0..15].
 *       Always call before using the digest[] variable.
*/

 void SDLTest_Md5Final(SDLTest_Md5Context * mdContext);


/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_test_md5_h_ */

/* vi: set ts=4 sw=4 expandtab: */
