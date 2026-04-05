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
 * # CategoryAtomic
 *
 * Atomic operations.
 *
 * IMPORTANT: If you are not an expert in concurrent lockless programming, you
 * should not be using any functions in this file. You should be protecting
 * your data structures with full mutexes instead.
 *
 * ***Seriously, here be dragons!***
 *
 * You can find out a little more about lockless programming and the subtle
 * issues that can arise here:
 * https://learn.microsoft.com/en-us/windows/win32/dxtecharts/lockless-programming
 *
 * There's also lots of good information here:
 *
 * - https://www.1024cores.net/home/lock-free-algorithms
 * - https://preshing.com/
 *
 * These operations may or may not actually be implemented using processor
 * specific atomic operations. When possible they are implemented as true
 * processor specific atomic operations. When that is not possible the are
 * implemented using locks that *do* use the available atomic operations.
 *
 * All of the atomic operations that modify memory are full memory barriers.
 */

#ifndef SDL_atomic_h_
#define SDL_atomic_h_

#include "SDL_stdinc.h"
#include "SDL_platform.h"

#include "begin_code.h"

/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/**
 * \name SDL AtomicLock
 *
 * The atomic locks are efficient spinlocks using CPU instructions,
 * but are vulnerable to starvation and can spin forever if a thread
 * holding a lock has been terminated.  For this reason you should
 * minimize the code executed inside an atomic lock and never do
 * expensive things like API or system calls while holding them.
 *
 * The atomic locks are not safe to lock recursively.
 *
 * Porting Note:
 * The spin lock functions and type are required and can not be
 * emulated because they are used in the atomic emulation code.
 */
/* @{ */

typedef int SDL_SpinLock;

/**
 * Try to lock a spin lock by setting it to a non-zero value.
 *
 * ***Please note that spinlocks are dangerous if you don't know what you're
 * doing. Please be careful using any sort of spinlock!***
 *
 * \param lock a pointer to a lock variable.
 * \returns SDL_TRUE if the lock succeeded, SDL_FALSE if the lock is already
 *          held.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AtomicLock
 * \sa SDL_AtomicUnlock
 */
extern DECLSPEC SDL_bool SDLCALL SDL_AtomicTryLock(SDL_SpinLock *lock);

/**
 * Lock a spin lock by setting it to a non-zero value.
 *
 * ***Please note that spinlocks are dangerous if you don't know what you're
 * doing. Please be careful using any sort of spinlock!***
 *
 * \param lock a pointer to a lock variable.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AtomicTryLock
 * \sa SDL_AtomicUnlock
 */
extern DECLSPEC void SDLCALL SDL_AtomicLock(SDL_SpinLock *lock);

/**
 * Unlock a spin lock by setting it to 0.
 *
 * Always returns immediately.
 *
 * ***Please note that spinlocks are dangerous if you don't know what you're
 * doing. Please be careful using any sort of spinlock!***
 *
 * \param lock a pointer to a lock variable.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AtomicLock
 * \sa SDL_AtomicTryLock
 */
extern DECLSPEC void SDLCALL SDL_AtomicUnlock(SDL_SpinLock *lock);

/* @} *//* SDL AtomicLock */


/**
 * The compiler barrier prevents the compiler from reordering
 * reads and writes to globally visible variables across the call.
 */
#if defined(_MSC_VER) && (_MSC_VER > 1200) && !defined(__clang__)
void _ReadWriteBarrier(void);
#pragma intrinsic(_ReadWriteBarrier)
#define SDL_CompilerBarrier()   _ReadWriteBarrier()
#elif (defined(__GNUC__) && !defined(__EMSCRIPTEN__)) || (defined(__SUNPRO_C) && (__SUNPRO_C >= 0x5120))
/* This is correct for all CPUs when using GCC or Solaris Studio 12.1+. */
#define SDL_CompilerBarrier()   __asm__ __volatile__ ("" : : : "memory")
#elif defined(__WATCOMC__)
extern __inline void SDL_CompilerBarrier(void);
#pragma aux SDL_CompilerBarrier = "" parm [] modify exact [];
#else
#define SDL_CompilerBarrier()   \
{ SDL_SpinLock _tmp = 0; SDL_AtomicLock(&_tmp); SDL_AtomicUnlock(&_tmp); }
#endif

/**
 * Memory barriers are designed to prevent reads and writes from being
 * reordered by the compiler and being seen out of order on multi-core CPUs.
 *
 * A typical pattern would be for thread A to write some data and a flag, and
 * for thread B to read the flag and get the data. In this case you would
 * insert a release barrier between writing the data and the flag,
 * guaranteeing that the data write completes no later than the flag is
 * written, and you would insert an acquire barrier between reading the flag
 * and reading the data, to ensure that all the reads associated with the flag
 * have completed.
 *
 * In this pattern you should always see a release barrier paired with an
 * acquire barrier and you should gate the data reads/writes with a single
 * flag variable.
 *
 * For more information on these semantics, take a look at the blog post:
 * http://preshing.com/20120913/acquire-and-release-semantics
 *
 * \since This function is available since SDL 2.0.6.
 */
extern DECLSPEC void SDLCALL SDL_MemoryBarrierReleaseFunction(void);
extern DECLSPEC void SDLCALL SDL_MemoryBarrierAcquireFunction(void);

#if defined(__GNUC__) && (defined(__powerpc__) || defined(__ppc__))
#define SDL_MemoryBarrierRelease()   __asm__ __volatile__ ("lwsync" : : : "memory")
#define SDL_MemoryBarrierAcquire()   __asm__ __volatile__ ("lwsync" : : : "memory")
#elif defined(__GNUC__) && defined(__aarch64__)
#define SDL_MemoryBarrierRelease()   __asm__ __volatile__ ("dmb ish" : : : "memory")
#define SDL_MemoryBarrierAcquire()   __asm__ __volatile__ ("dmb ish" : : : "memory")
#elif defined(__GNUC__) && defined(__arm__)
#if 0 /* defined(__LINUX__) || defined(__ANDROID__) */
/* Information from:
   https://chromium.googlesource.com/chromium/chromium/+/trunk/base/atomicops_internals_arm_gcc.h#19

   The Linux kernel provides a helper function which provides the right code for a memory barrier,
   hard-coded at address 0xffff0fa0
*/
typedef void (*SDL_KernelMemoryBarrierFunc)();
#define SDL_MemoryBarrierRelease()	((SDL_KernelMemoryBarrierFunc)0xffff0fa0)()
#define SDL_MemoryBarrierAcquire()	((SDL_KernelMemoryBarrierFunc)0xffff0fa0)()
#elif 0 /* defined(__QNXNTO__) */
#include <sys/cpuinline.h>

#define SDL_MemoryBarrierRelease()   __cpu_membarrier()
#define SDL_MemoryBarrierAcquire()   __cpu_membarrier()
#else
#if defined(__ARM_ARCH_7__) || defined(__ARM_ARCH_7A__) || defined(__ARM_ARCH_7EM__) || defined(__ARM_ARCH_7R__) || defined(__ARM_ARCH_7M__) || defined(__ARM_ARCH_7S__) || defined(__ARM_ARCH_8A__)
#define SDL_MemoryBarrierRelease()   __asm__ __volatile__ ("dmb ish" : : : "memory")
#define SDL_MemoryBarrierAcquire()   __asm__ __volatile__ ("dmb ish" : : : "memory")
#elif defined(__ARM_ARCH_6__) || defined(__ARM_ARCH_6J__) || defined(__ARM_ARCH_6K__) || defined(__ARM_ARCH_6T2__) || defined(__ARM_ARCH_6Z__) || defined(__ARM_ARCH_6ZK__)
#ifdef __thumb__
/* The mcr instruction isn't available in thumb mode, use real functions */
#define SDL_MEMORY_BARRIER_USES_FUNCTION
#define SDL_MemoryBarrierRelease()   SDL_MemoryBarrierReleaseFunction()
#define SDL_MemoryBarrierAcquire()   SDL_MemoryBarrierAcquireFunction()
#else
#define SDL_MemoryBarrierRelease()   __asm__ __volatile__ ("mcr p15, 0, %0, c7, c10, 5" : : "r"(0) : "memory")
#define SDL_MemoryBarrierAcquire()   __asm__ __volatile__ ("mcr p15, 0, %0, c7, c10, 5" : : "r"(0) : "memory")
#endif /* __thumb__ */
#else
#define SDL_MemoryBarrierRelease()   __asm__ __volatile__ ("" : : : "memory")
#define SDL_MemoryBarrierAcquire()   __asm__ __volatile__ ("" : : : "memory")
#endif /* __LINUX__ || __ANDROID__ */
#endif /* __GNUC__ && __arm__ */
#else
#if (defined(__SUNPRO_C) && (__SUNPRO_C >= 0x5120))
/* This is correct for all CPUs on Solaris when using Solaris Studio 12.1+. */
#include <mbarrier.h>
#define SDL_MemoryBarrierRelease()  __machine_rel_barrier()
#define SDL_MemoryBarrierAcquire()  __machine_acq_barrier()
#else
/* This is correct for the x86 and x64 CPUs, and we'll expand this over time. */
#define SDL_MemoryBarrierRelease()  SDL_CompilerBarrier()
#define SDL_MemoryBarrierAcquire()  SDL_CompilerBarrier()
#endif
#endif

/* "REP NOP" is PAUSE, coded for tools that don't know it by that name. */
#if (defined(__GNUC__) || defined(__clang__)) && (defined(__i386__) || defined(__x86_64__))
    #define SDL_CPUPauseInstruction() __asm__ __volatile__("pause\n")  /* Some assemblers can't do REP NOP, so go with PAUSE. */
#elif (defined(__arm__) && defined(__ARM_ARCH) && __ARM_ARCH >= 7) || defined(__aarch64__)
    #define SDL_CPUPauseInstruction() __asm__ __volatile__("yield" ::: "memory")
#elif (defined(__powerpc__) || defined(__powerpc64__))
    #define SDL_CPUPauseInstruction() __asm__ __volatile__("or 27,27,27");
#elif defined(_MSC_VER) && (defined(_M_IX86) || defined(_M_X64))
    #define SDL_CPUPauseInstruction() _mm_pause()  /* this is actually "rep nop" and not a SIMD instruction. No inline asm in MSVC x86-64! */
#elif defined(_MSC_VER) && (defined(_M_ARM) || defined(_M_ARM64))
    #define SDL_CPUPauseInstruction() __yield()
#elif defined(__WATCOMC__) && defined(__386__)
    extern __inline void SDL_CPUPauseInstruction(void);
    #pragma aux SDL_CPUPauseInstruction = ".686p" ".xmm2" "pause"
#else
    #define SDL_CPUPauseInstruction()
#endif


/**
 * A type representing an atomic integer value.
 *
 * It is a struct so people don't accidentally use numeric operations on it.
 */
typedef struct SDL_atomic_t {
    int value;
} SDL_atomic_t;

/**
 * Set an atomic variable to a new value if it is currently an old value.
 *
 * ***Note: If you don't know what this function is for, you shouldn't use
 * it!***
 *
 * \param a a pointer to an SDL_atomic_t variable to be modified.
 * \param oldval the old value.
 * \param newval the new value.
 * \returns SDL_TRUE if the atomic variable was set, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AtomicCASPtr
 * \sa SDL_AtomicGet
 * \sa SDL_AtomicSet
 */
extern DECLSPEC SDL_bool SDLCALL SDL_AtomicCAS(SDL_atomic_t *a, int oldval, int newval);

/**
 * Set an atomic variable to a value.
 *
 * This function also acts as a full memory barrier.
 *
 * ***Note: If you don't know what this function is for, you shouldn't use
 * it!***
 *
 * \param a a pointer to an SDL_atomic_t variable to be modified.
 * \param v the desired value.
 * \returns the previous value of the atomic variable.
 *
 * \since This function is available since SDL 2.0.2.
 *
 * \sa SDL_AtomicGet
 */
extern DECLSPEC int SDLCALL SDL_AtomicSet(SDL_atomic_t *a, int v);

/**
 * Get the value of an atomic variable.
 *
 * ***Note: If you don't know what this function is for, you shouldn't use
 * it!***
 *
 * \param a a pointer to an SDL_atomic_t variable.
 * \returns the current value of an atomic variable.
 *
 * \since This function is available since SDL 2.0.2.
 *
 * \sa SDL_AtomicSet
 */
extern DECLSPEC int SDLCALL SDL_AtomicGet(SDL_atomic_t *a);

/**
 * Add to an atomic variable.
 *
 * This function also acts as a full memory barrier.
 *
 * ***Note: If you don't know what this function is for, you shouldn't use
 * it!***
 *
 * \param a a pointer to an SDL_atomic_t variable to be modified.
 * \param v the desired value to add.
 * \returns the previous value of the atomic variable.
 *
 * \since This function is available since SDL 2.0.2.
 *
 * \sa SDL_AtomicDecRef
 * \sa SDL_AtomicIncRef
 */
extern DECLSPEC int SDLCALL SDL_AtomicAdd(SDL_atomic_t *a, int v);

/**
 * \brief Increment an atomic variable used as a reference count.
 */
#ifndef SDL_AtomicIncRef
#define SDL_AtomicIncRef(a)    SDL_AtomicAdd(a, 1)
#endif

/**
 * \brief Decrement an atomic variable used as a reference count.
 *
 * \return SDL_TRUE if the variable reached zero after decrementing,
 *         SDL_FALSE otherwise
 */
#ifndef SDL_AtomicDecRef
#define SDL_AtomicDecRef(a)    (SDL_AtomicAdd(a, -1) == 1)
#endif

/**
 * Set a pointer to a new value if it is currently an old value.
 *
 * ***Note: If you don't know what this function is for, you shouldn't use
 * it!***
 *
 * \param a a pointer to a pointer.
 * \param oldval the old pointer value.
 * \param newval the new pointer value.
 * \returns SDL_TRUE if the pointer was set, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AtomicCAS
 * \sa SDL_AtomicGetPtr
 * \sa SDL_AtomicSetPtr
 */
extern DECLSPEC SDL_bool SDLCALL SDL_AtomicCASPtr(void **a, void *oldval, void *newval);

/**
 * Set a pointer to a value atomically.
 *
 * ***Note: If you don't know what this function is for, you shouldn't use
 * it!***
 *
 * \param a a pointer to a pointer.
 * \param v the desired pointer value.
 * \returns the previous value of the pointer.
 *
 * \since This function is available since SDL 2.0.2.
 *
 * \sa SDL_AtomicCASPtr
 * \sa SDL_AtomicGetPtr
 */
extern DECLSPEC void* SDLCALL SDL_AtomicSetPtr(void **a, void* v);

/**
 * Get the value of a pointer atomically.
 *
 * ***Note: If you don't know what this function is for, you shouldn't use
 * it!***
 *
 * \param a a pointer to a pointer.
 * \returns the current value of a pointer.
 *
 * \since This function is available since SDL 2.0.2.
 *
 * \sa SDL_AtomicCASPtr
 * \sa SDL_AtomicSetPtr
 */
extern DECLSPEC void* SDLCALL SDL_AtomicGetPtr(void **a);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif

#include "close_code.h"

#endif /* SDL_atomic_h_ */

/* vi: set ts=4 sw=4 expandtab: */
