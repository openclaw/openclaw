/* (C) COPYRIGHT 1994-2002 Xiph.Org Foundation */
/* Modified by Jean-Marc Valin */
/*
   Redistribution and use in source and binary forms, with or without
   modification, are permitted provided that the following conditions
   are met:

   - Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

   - Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
   ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
   LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
   A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER
   OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
   EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
   PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
   PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
   LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
   NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
   SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
/* opus_types.h based on ogg_types.h from libogg */

/**
   @file opus_types.h
   @brief Opus reference implementation types
*/
#ifndef OPUS_TYPES_H
#define OPUS_TYPES_H

#define opus_int         int                     /* used for counters etc; at least 16 bits */
#define opus_int64       long long
#define opus_int8        signed char

#define opus_uint        unsigned int            /* used for counters etc; at least 16 bits */
#define opus_uint64      unsigned long long
#define opus_uint8       unsigned char

/* Use the real stdint.h if it's there (taken from Paul Hsieh's pstdint.h) */
#if (defined(__STDC__) && __STDC__ && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L) || (defined(__GNUC__) && (defined(_STDINT_H) || defined(_STDINT_H_)) || defined (HAVE_STDINT_H))
#include <stdint.h>
#  undef opus_int64
#  undef opus_int8
#  undef opus_uint64
#  undef opus_uint8
   typedef int8_t opus_int8;
   typedef uint8_t opus_uint8;
   typedef int16_t opus_int16;
   typedef uint16_t opus_uint16;
   typedef int32_t opus_int32;
   typedef uint32_t opus_uint32;
   typedef int64_t opus_int64;
   typedef uint64_t opus_uint64;
#elif defined(_WIN32)

#  if defined(__CYGWIN__)
#    include <_G_config.h>
     typedef _G_int32_t opus_int32;
     typedef _G_uint32_t opus_uint32;
     typedef _G_int16 opus_int16;
     typedef _G_uint16 opus_uint16;
#  elif defined(__MINGW32__)
     typedef short opus_int16;
     typedef unsigned short opus_uint16;
     typedef int opus_int32;
     typedef unsigned int opus_uint32;
#  elif defined(__MWERKS__)
     typedef int opus_int32;
     typedef unsigned int opus_uint32;
     typedef short opus_int16;
     typedef unsigned short opus_uint16;
#  else
     /* MSVC/Borland */
     typedef __int32 opus_int32;
     typedef unsigned __int32 opus_uint32;
     typedef __int16 opus_int16;
     typedef unsigned __int16 opus_uint16;
#  endif

#elif defined(__MACOS__)

#  include <sys/types.h>
   typedef SInt16 opus_int16;
   typedef UInt16 opus_uint16;
   typedef SInt32 opus_int32;
   typedef UInt32 opus_uint32;

#elif (defined(__APPLE__) && defined(__MACH__)) /* MacOS X Framework build */

#  include <sys/types.h>
   typedef int16_t opus_int16;
   typedef u_int16_t opus_uint16;
   typedef int32_t opus_int32;
   typedef u_int32_t opus_uint32;

#elif defined(__BEOS__)

   /* Be */
#  include <inttypes.h>
   typedef int16 opus_int16;
   typedef u_int16 opus_uint16;
   typedef int32_t opus_int32;
   typedef u_int32_t opus_uint32;

#elif defined (__EMX__)

   /* OS/2 GCC */
   typedef short opus_int16;
   typedef unsigned short opus_uint16;
   typedef int opus_int32;
   typedef unsigned int opus_uint32;

#elif defined (DJGPP)

   /* DJGPP */
   typedef short opus_int16;
   typedef unsigned short opus_uint16;
   typedef int opus_int32;
   typedef unsigned int opus_uint32;

#elif defined(R5900)

   /* PS2 EE */
   typedef int opus_int32;
   typedef unsigned opus_uint32;
   typedef short opus_int16;
   typedef unsigned short opus_uint16;

#elif defined(__SYMBIAN32__)

   /* Symbian GCC */
   typedef signed short opus_int16;
   typedef unsigned short opus_uint16;
   typedef signed int opus_int32;
   typedef unsigned int opus_uint32;

#elif defined(CONFIG_TI_C54X) || defined (CONFIG_TI_C55X)

   typedef short opus_int16;
   typedef unsigned short opus_uint16;
   typedef long opus_int32;
   typedef unsigned long opus_uint32;

#elif defined(CONFIG_TI_C6X)

   typedef short opus_int16;
   typedef unsigned short opus_uint16;
   typedef int opus_int32;
   typedef unsigned int opus_uint32;

#else

   /* Give up, take a reasonable guess */
   typedef short opus_int16;
   typedef unsigned short opus_uint16;
   typedef int opus_int32;
   typedef unsigned int opus_uint32;

#endif

#endif  /* OPUS_TYPES_H */
