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

/* WIKI CATEGORY: CPUInfo */

/**
 * # CategoryCPUInfo
 *
 * CPU feature detection for SDL.
 *
 * These functions are largely concerned with reporting if the system has
 * access to various SIMD instruction sets, but also has other important info
 * to share, such as number of logical CPU cores.
 */

#ifndef SDL_cpuinfo_h_
#define SDL_cpuinfo_h_

#include "SDL_stdinc.h"

/* Need to do this here because intrin.h has C++ code in it */
/* Visual Studio 2005 has a bug where intrin.h conflicts with winnt.h */
#if defined(_MSC_VER) && (_MSC_VER >= 1500) && (defined(_M_IX86) || defined(_M_X64))
#ifdef __clang__
/* As of Clang 11, '_m_prefetchw' is conflicting with the winnt.h's version,
   so we define the needed '_m_prefetch' here as a pseudo-header, until the issue is fixed. */

#ifndef __PRFCHWINTRIN_H
#define __PRFCHWINTRIN_H

static __inline__ void __attribute__((__always_inline__, __nodebug__))
_m_prefetch(void *__P)
{
  __builtin_prefetch (__P, 0, 3 /* _MM_HINT_T0 */);
}

#endif /* __PRFCHWINTRIN_H */
#endif /* __clang__ */
#include <intrin.h>
#ifndef _WIN64
#ifndef __MMX__
#define __MMX__
#endif
/*
#ifndef __3dNOW__
#define __3dNOW__
#endif
*/
#endif
#ifndef __SSE__
#define __SSE__
#endif
#ifndef __SSE2__
#define __SSE2__
#endif
#ifndef __SSE3__
#define __SSE3__
#endif
#elif defined(__MINGW64_VERSION_MAJOR)
#include <intrin.h>
#if !defined(SDL_DISABLE_ARM_NEON_H) && defined(__ARM_NEON)
#  include <arm_neon.h>
#endif
#else
/* altivec.h redefining bool causes a number of problems, see bugs 3993 and 4392, so you need to explicitly define SDL_ENABLE_ALTIVEC_H to have it included. */
#if defined(HAVE_ALTIVEC_H) && defined(__ALTIVEC__) && !defined(__APPLE_ALTIVEC__) && defined(SDL_ENABLE_ALTIVEC_H)
#include <altivec.h>
#endif
#if !defined(SDL_DISABLE_ARM_NEON_H)
#  if defined(__ARM_NEON)
#    include <arm_neon.h>
#  elif defined(__WINDOWS__) || defined(__WINRT__) || defined(__GDK__)
/* Visual Studio doesn't define __ARM_ARCH, but _M_ARM (if set, always 7), and _M_ARM64 (if set, always 1). */
#    if defined(_M_ARM)
#      include <armintr.h>
#      include <arm_neon.h>
#      define __ARM_NEON 1 /* Set __ARM_NEON so that it can be used elsewhere, at compile time */
#    endif
#    if defined (_M_ARM64)
#      include <arm64intr.h>
#      include <arm64_neon.h>
#      define __ARM_NEON 1 /* Set __ARM_NEON so that it can be used elsewhere, at compile time */
#      define __ARM_ARCH 8
#    endif
#  endif
#endif
#endif /* compiler version */

#if defined(__3dNOW__) && !defined(SDL_DISABLE_MM3DNOW_H)
#include <mm3dnow.h>
#endif
#if defined(__loongarch_sx) && !defined(SDL_DISABLE_LSX_H)
#include <lsxintrin.h>
#define __LSX__
#endif
#if defined(__loongarch_asx) && !defined(SDL_DISABLE_LASX_H)
#include <lasxintrin.h>
#define __LASX__
#endif
#if defined(HAVE_IMMINTRIN_H) && !defined(SDL_DISABLE_IMMINTRIN_H) && \
   (defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86))
#include <immintrin.h>
#else
#if defined(__MMX__) && !defined(SDL_DISABLE_MMINTRIN_H)
#include <mmintrin.h>
#endif
#if defined(__SSE__) && !defined(SDL_DISABLE_XMMINTRIN_H)
#include <xmmintrin.h>
#endif
#if defined(__SSE2__) && !defined(SDL_DISABLE_EMMINTRIN_H)
#include <emmintrin.h>
#endif
#if defined(__SSE3__) && !defined(SDL_DISABLE_PMMINTRIN_H)
#include <pmmintrin.h>
#endif
#endif /* HAVE_IMMINTRIN_H */

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/* This is a guess for the cacheline size used for padding.
 * Most x86 processors have a 64 byte cache line.
 * The 64-bit PowerPC processors have a 128 byte cache line.
 * We'll use the larger value to be generally safe.
 */
#define SDL_CACHELINE_SIZE  128

/**
 * Get the number of CPU cores available.
 *
 * \returns the total number of logical CPU cores. On CPUs that include
 *          technologies such as hyperthreading, the number of logical cores
 *          may be more than the number of physical cores.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC int SDLCALL SDL_GetCPUCount(void);

/**
 * Determine the L1 cache line size of the CPU.
 *
 * This is useful for determining multi-threaded structure padding or SIMD
 * prefetch sizes.
 *
 * \returns the L1 cache line size of the CPU, in bytes.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC int SDLCALL SDL_GetCPUCacheLineSize(void);

/**
 * Determine whether the CPU has the RDTSC instruction.
 *
 * This always returns false on CPUs that aren't using Intel instruction sets.
 *
 * \returns SDL_TRUE if the CPU has the RDTSC instruction or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Has3DNow
 * \sa SDL_HasAltiVec
 * \sa SDL_HasAVX
 * \sa SDL_HasAVX2
 * \sa SDL_HasMMX
 * \sa SDL_HasSSE
 * \sa SDL_HasSSE2
 * \sa SDL_HasSSE3
 * \sa SDL_HasSSE41
 * \sa SDL_HasSSE42
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasRDTSC(void);

/**
 * Determine whether the CPU has AltiVec features.
 *
 * This always returns false on CPUs that aren't using PowerPC instruction
 * sets.
 *
 * \returns SDL_TRUE if the CPU has AltiVec features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Has3DNow
 * \sa SDL_HasAVX
 * \sa SDL_HasAVX2
 * \sa SDL_HasMMX
 * \sa SDL_HasRDTSC
 * \sa SDL_HasSSE
 * \sa SDL_HasSSE2
 * \sa SDL_HasSSE3
 * \sa SDL_HasSSE41
 * \sa SDL_HasSSE42
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasAltiVec(void);

/**
 * Determine whether the CPU has MMX features.
 *
 * This always returns false on CPUs that aren't using Intel instruction sets.
 *
 * \returns SDL_TRUE if the CPU has MMX features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Has3DNow
 * \sa SDL_HasAltiVec
 * \sa SDL_HasAVX
 * \sa SDL_HasAVX2
 * \sa SDL_HasRDTSC
 * \sa SDL_HasSSE
 * \sa SDL_HasSSE2
 * \sa SDL_HasSSE3
 * \sa SDL_HasSSE41
 * \sa SDL_HasSSE42
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasMMX(void);

/**
 * Determine whether the CPU has 3DNow! features.
 *
 * This always returns false on CPUs that aren't using AMD instruction sets.
 *
 * \returns SDL_TRUE if the CPU has 3DNow! features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HasAltiVec
 * \sa SDL_HasAVX
 * \sa SDL_HasAVX2
 * \sa SDL_HasMMX
 * \sa SDL_HasRDTSC
 * \sa SDL_HasSSE
 * \sa SDL_HasSSE2
 * \sa SDL_HasSSE3
 * \sa SDL_HasSSE41
 * \sa SDL_HasSSE42
 */
extern DECLSPEC SDL_bool SDLCALL SDL_Has3DNow(void);

/**
 * Determine whether the CPU has SSE features.
 *
 * This always returns false on CPUs that aren't using Intel instruction sets.
 *
 * \returns SDL_TRUE if the CPU has SSE features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Has3DNow
 * \sa SDL_HasAltiVec
 * \sa SDL_HasAVX
 * \sa SDL_HasAVX2
 * \sa SDL_HasMMX
 * \sa SDL_HasRDTSC
 * \sa SDL_HasSSE2
 * \sa SDL_HasSSE3
 * \sa SDL_HasSSE41
 * \sa SDL_HasSSE42
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasSSE(void);

/**
 * Determine whether the CPU has SSE2 features.
 *
 * This always returns false on CPUs that aren't using Intel instruction sets.
 *
 * \returns SDL_TRUE if the CPU has SSE2 features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Has3DNow
 * \sa SDL_HasAltiVec
 * \sa SDL_HasAVX
 * \sa SDL_HasAVX2
 * \sa SDL_HasMMX
 * \sa SDL_HasRDTSC
 * \sa SDL_HasSSE
 * \sa SDL_HasSSE3
 * \sa SDL_HasSSE41
 * \sa SDL_HasSSE42
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasSSE2(void);

/**
 * Determine whether the CPU has SSE3 features.
 *
 * This always returns false on CPUs that aren't using Intel instruction sets.
 *
 * \returns SDL_TRUE if the CPU has SSE3 features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Has3DNow
 * \sa SDL_HasAltiVec
 * \sa SDL_HasAVX
 * \sa SDL_HasAVX2
 * \sa SDL_HasMMX
 * \sa SDL_HasRDTSC
 * \sa SDL_HasSSE
 * \sa SDL_HasSSE2
 * \sa SDL_HasSSE41
 * \sa SDL_HasSSE42
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasSSE3(void);

/**
 * Determine whether the CPU has SSE4.1 features.
 *
 * This always returns false on CPUs that aren't using Intel instruction sets.
 *
 * \returns SDL_TRUE if the CPU has SSE4.1 features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Has3DNow
 * \sa SDL_HasAltiVec
 * \sa SDL_HasAVX
 * \sa SDL_HasAVX2
 * \sa SDL_HasMMX
 * \sa SDL_HasRDTSC
 * \sa SDL_HasSSE
 * \sa SDL_HasSSE2
 * \sa SDL_HasSSE3
 * \sa SDL_HasSSE42
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasSSE41(void);

/**
 * Determine whether the CPU has SSE4.2 features.
 *
 * This always returns false on CPUs that aren't using Intel instruction sets.
 *
 * \returns SDL_TRUE if the CPU has SSE4.2 features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Has3DNow
 * \sa SDL_HasAltiVec
 * \sa SDL_HasAVX
 * \sa SDL_HasAVX2
 * \sa SDL_HasMMX
 * \sa SDL_HasRDTSC
 * \sa SDL_HasSSE
 * \sa SDL_HasSSE2
 * \sa SDL_HasSSE3
 * \sa SDL_HasSSE41
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasSSE42(void);

/**
 * Determine whether the CPU has AVX features.
 *
 * This always returns false on CPUs that aren't using Intel instruction sets.
 *
 * \returns SDL_TRUE if the CPU has AVX features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.2.
 *
 * \sa SDL_Has3DNow
 * \sa SDL_HasAltiVec
 * \sa SDL_HasAVX2
 * \sa SDL_HasMMX
 * \sa SDL_HasRDTSC
 * \sa SDL_HasSSE
 * \sa SDL_HasSSE2
 * \sa SDL_HasSSE3
 * \sa SDL_HasSSE41
 * \sa SDL_HasSSE42
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasAVX(void);

/**
 * Determine whether the CPU has AVX2 features.
 *
 * This always returns false on CPUs that aren't using Intel instruction sets.
 *
 * \returns SDL_TRUE if the CPU has AVX2 features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.4.
 *
 * \sa SDL_Has3DNow
 * \sa SDL_HasAltiVec
 * \sa SDL_HasAVX
 * \sa SDL_HasMMX
 * \sa SDL_HasRDTSC
 * \sa SDL_HasSSE
 * \sa SDL_HasSSE2
 * \sa SDL_HasSSE3
 * \sa SDL_HasSSE41
 * \sa SDL_HasSSE42
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasAVX2(void);

/**
 * Determine whether the CPU has AVX-512F (foundation) features.
 *
 * This always returns false on CPUs that aren't using Intel instruction sets.
 *
 * \returns SDL_TRUE if the CPU has AVX-512F features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.9.
 *
 * \sa SDL_HasAVX
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasAVX512F(void);

/**
 * Determine whether the CPU has ARM SIMD (ARMv6) features.
 *
 * This is different from ARM NEON, which is a different instruction set.
 *
 * This always returns false on CPUs that aren't using ARM instruction sets.
 *
 * \returns SDL_TRUE if the CPU has ARM SIMD features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.12.
 *
 * \sa SDL_HasNEON
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasARMSIMD(void);

/**
 * Determine whether the CPU has NEON (ARM SIMD) features.
 *
 * This always returns false on CPUs that aren't using ARM instruction sets.
 *
 * \returns SDL_TRUE if the CPU has ARM NEON features or SDL_FALSE if not.
 *
 * \since This function is available since SDL 2.0.6.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasNEON(void);

/**
 * Determine whether the CPU has LSX (LOONGARCH SIMD) features.
 *
 * This always returns false on CPUs that aren't using LOONGARCH instruction
 * sets.
 *
 * \returns SDL_TRUE if the CPU has LOONGARCH LSX features or SDL_FALSE if
 *          not.
 *
 * \since This function is available since SDL 2.24.0.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasLSX(void);

/**
 * Determine whether the CPU has LASX (LOONGARCH SIMD) features.
 *
 * This always returns false on CPUs that aren't using LOONGARCH instruction
 * sets.
 *
 * \returns SDL_TRUE if the CPU has LOONGARCH LASX features or SDL_FALSE if
 *          not.
 *
 * \since This function is available since SDL 2.24.0.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasLASX(void);

/**
 * Get the amount of RAM configured in the system.
 *
 * \returns the amount of RAM configured in the system in MiB.
 *
 * \since This function is available since SDL 2.0.1.
 */
extern DECLSPEC int SDLCALL SDL_GetSystemRAM(void);

/**
 * Report the alignment this system needs for SIMD allocations.
 *
 * This will return the minimum number of bytes to which a pointer must be
 * aligned to be compatible with SIMD instructions on the current machine. For
 * example, if the machine supports SSE only, it will return 16, but if it
 * supports AVX-512F, it'll return 64 (etc). This only reports values for
 * instruction sets SDL knows about, so if your SDL build doesn't have
 * SDL_HasAVX512F(), then it might return 16 for the SSE support it sees and
 * not 64 for the AVX-512 instructions that exist but SDL doesn't know about.
 * Plan accordingly.
 *
 * \returns the alignment in bytes needed for available, known SIMD
 *          instructions.
 *
 * \since This function is available since SDL 2.0.10.
 */
extern DECLSPEC size_t SDLCALL SDL_SIMDGetAlignment(void);

/**
 * Allocate memory in a SIMD-friendly way.
 *
 * This will allocate a block of memory that is suitable for use with SIMD
 * instructions. Specifically, it will be properly aligned and padded for the
 * system's supported vector instructions.
 *
 * The memory returned will be padded such that it is safe to read or write an
 * incomplete vector at the end of the memory block. This can be useful so you
 * don't have to drop back to a scalar fallback at the end of your SIMD
 * processing loop to deal with the final elements without overflowing the
 * allocated buffer.
 *
 * You must free this memory with SDL_FreeSIMD(), not free() or SDL_free() or
 * delete[], etc.
 *
 * Note that SDL will only deal with SIMD instruction sets it is aware of; for
 * example, SDL 2.0.8 knows that SSE wants 16-byte vectors (SDL_HasSSE()), and
 * AVX2 wants 32 bytes (SDL_HasAVX2()), but doesn't know that AVX-512 wants
 * 64. To be clear: if you can't decide to use an instruction set with an
 * SDL_Has*() function, don't use that instruction set with memory allocated
 * through here.
 *
 * SDL_AllocSIMD(0) will return a non-NULL pointer, assuming the system isn't
 * out of memory, but you are not allowed to dereference it (because you only
 * own zero bytes of that buffer).
 *
 * \param len The length, in bytes, of the block to allocate. The actual
 *            allocated block might be larger due to padding, etc.
 * \returns a pointer to the newly-allocated block, NULL if out of memory.
 *
 * \since This function is available since SDL 2.0.10.
 *
 * \sa SDL_SIMDGetAlignment
 * \sa SDL_SIMDRealloc
 * \sa SDL_SIMDFree
 */
extern DECLSPEC void * SDLCALL SDL_SIMDAlloc(const size_t len);

/**
 * Reallocate memory obtained from SDL_SIMDAlloc
 *
 * It is not valid to use this function on a pointer from anything but
 * SDL_SIMDAlloc(). It can't be used on pointers from malloc, realloc,
 * SDL_malloc, memalign, new[], etc.
 *
 * \param mem The pointer obtained from SDL_SIMDAlloc. This function also
 *            accepts NULL, at which point this function is the same as
 *            calling SDL_SIMDAlloc with a NULL pointer.
 * \param len The length, in bytes, of the block to allocated. The actual
 *            allocated block might be larger due to padding, etc. Passing 0
 *            will return a non-NULL pointer, assuming the system isn't out of
 *            memory.
 * \returns a pointer to the newly-reallocated block, NULL if out of memory.
 *
 * \since This function is available since SDL 2.0.14.
 *
 * \sa SDL_SIMDGetAlignment
 * \sa SDL_SIMDAlloc
 * \sa SDL_SIMDFree
 */
extern DECLSPEC void * SDLCALL SDL_SIMDRealloc(void *mem, const size_t len);

/**
 * Deallocate memory obtained from SDL_SIMDAlloc
 *
 * It is not valid to use this function on a pointer from anything but
 * SDL_SIMDAlloc() or SDL_SIMDRealloc(). It can't be used on pointers from
 * malloc, realloc, SDL_malloc, memalign, new[], etc.
 *
 * However, SDL_SIMDFree(NULL) is a legal no-op.
 *
 * The memory pointed to by `ptr` is no longer valid for access upon return,
 * and may be returned to the system or reused by a future allocation. The
 * pointer passed to this function is no longer safe to dereference once this
 * function returns, and should be discarded.
 *
 * \param ptr The pointer, returned from SDL_SIMDAlloc or SDL_SIMDRealloc, to
 *            deallocate. NULL is a legal no-op.
 *
 * \since This function is available since SDL 2.0.10.
 *
 * \sa SDL_SIMDAlloc
 * \sa SDL_SIMDRealloc
 */
extern DECLSPEC void SDLCALL SDL_SIMDFree(void *ptr);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_cpuinfo_h_ */

/* vi: set ts=4 sw=4 expandtab: */
