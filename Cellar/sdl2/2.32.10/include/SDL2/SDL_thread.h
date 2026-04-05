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

#ifndef SDL_thread_h_
#define SDL_thread_h_

/**
 * # CategoryThread
 *
 * Header for the SDL thread management routines.
 */

#include "SDL_stdinc.h"
#include "SDL_error.h"

/* Thread synchronization primitives */
#include "SDL_atomic.h"
#include "SDL_mutex.h"

#if (defined(__WIN32__) || defined(__GDK__)) && !defined(__WINRT__)
#include <process.h> /* _beginthreadex() and _endthreadex() */
#endif
#if defined(__OS2__) /* for _beginthread() and _endthread() */
#ifndef __EMX__
#include <process.h>
#else
#include <stdlib.h>
#endif
#endif

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/* The SDL thread structure, defined in SDL_thread.c */
struct SDL_Thread;
typedef struct SDL_Thread SDL_Thread;

/* The SDL thread ID */
typedef unsigned long SDL_threadID;

/* Thread local storage ID, 0 is the invalid ID */
typedef unsigned int SDL_TLSID;

/**
 * The SDL thread priority.
 *
 * SDL will make system changes as necessary in order to apply the thread
 * priority. Code which attempts to control thread state related to priority
 * should be aware that calling SDL_SetThreadPriority may alter such state.
 * SDL_HINT_THREAD_PRIORITY_POLICY can be used to control aspects of this
 * behavior.
 *
 * On many systems you require special privileges to set high or time critical
 * priority.
 */
typedef enum SDL_ThreadPriority {
    SDL_THREAD_PRIORITY_LOW,
    SDL_THREAD_PRIORITY_NORMAL,
    SDL_THREAD_PRIORITY_HIGH,
    SDL_THREAD_PRIORITY_TIME_CRITICAL
} SDL_ThreadPriority;

/**
 * The function passed to SDL_CreateThread().
 *
 * \param data what was passed as `data` to SDL_CreateThread().
 * \returns a value that can be reported through SDL_WaitThread().
 */
typedef int (SDLCALL * SDL_ThreadFunction) (void *data);


#if (defined(__WIN32__) || defined(__GDK__)) && !defined(__WINRT__)
/**
 *  \file SDL_thread.h
 *
 *  We compile SDL into a DLL. This means, that it's the DLL which
 *  creates a new thread for the calling process with the SDL_CreateThread()
 *  API. There is a problem with this, that only the RTL of the SDL2.DLL will
 *  be initialized for those threads, and not the RTL of the calling
 *  application!
 *
 *  To solve this, we make a little hack here.
 *
 *  We'll always use the caller's _beginthread() and _endthread() APIs to
 *  start a new thread. This way, if it's the SDL2.DLL which uses this API,
 *  then the RTL of SDL2.DLL will be used to create the new thread, and if it's
 *  the application, then the RTL of the application will be used.
 *
 *  So, in short:
 *  Always use the _beginthread() and _endthread() of the calling runtime
 *  library!
 */
#define SDL_PASSED_BEGINTHREAD_ENDTHREAD

typedef uintptr_t (__cdecl * pfnSDL_CurrentBeginThread)
                   (void *, unsigned, unsigned (__stdcall *func)(void *),
                    void * /*arg*/, unsigned, unsigned * /* threadID */);
typedef void (__cdecl * pfnSDL_CurrentEndThread) (unsigned code);

#ifndef SDL_beginthread
#define SDL_beginthread _beginthreadex
#endif
#ifndef SDL_endthread
#define SDL_endthread _endthreadex
#endif

extern DECLSPEC SDL_Thread *SDLCALL
SDL_CreateThread(SDL_ThreadFunction fn, const char *name, void *data,
                 pfnSDL_CurrentBeginThread pfnBeginThread,
                 pfnSDL_CurrentEndThread pfnEndThread);

extern DECLSPEC SDL_Thread *SDLCALL
SDL_CreateThreadWithStackSize(SDL_ThreadFunction fn,
                 const char *name, const size_t stacksize, void *data,
                 pfnSDL_CurrentBeginThread pfnBeginThread,
                 pfnSDL_CurrentEndThread pfnEndThread);


#if defined(SDL_CreateThread) && SDL_DYNAMIC_API
#undef SDL_CreateThread
#define SDL_CreateThread(fn, name, data) SDL_CreateThread_REAL(fn, name, data, (pfnSDL_CurrentBeginThread)SDL_beginthread, (pfnSDL_CurrentEndThread)SDL_endthread)
#undef SDL_CreateThreadWithStackSize
#define SDL_CreateThreadWithStackSize(fn, name, stacksize, data) SDL_CreateThreadWithStackSize_REAL(fn, name, stacksize, data, (pfnSDL_CurrentBeginThread)SDL_beginthread, (pfnSDL_CurrentEndThread)SDL_endthread)
#else
#define SDL_CreateThread(fn, name, data) SDL_CreateThread(fn, name, data, (pfnSDL_CurrentBeginThread)SDL_beginthread, (pfnSDL_CurrentEndThread)SDL_endthread)
#define SDL_CreateThreadWithStackSize(fn, name, stacksize, data) SDL_CreateThreadWithStackSize(fn, name, stacksize, data, (pfnSDL_CurrentBeginThread)SDL_beginthread, (pfnSDL_CurrentEndThread)SDL_endthread)
#endif

#elif defined(__OS2__)
/*
 * just like the windows case above:  We compile SDL2
 * into a dll with Watcom's runtime statically linked.
 */
#define SDL_PASSED_BEGINTHREAD_ENDTHREAD

typedef int (*pfnSDL_CurrentBeginThread)(void (*func)(void *), void *, unsigned, void * /*arg*/);
typedef void (*pfnSDL_CurrentEndThread)(void);

#ifndef SDL_beginthread
#define SDL_beginthread _beginthread
#endif
#ifndef SDL_endthread
#define SDL_endthread _endthread
#endif

extern DECLSPEC SDL_Thread *SDLCALL
SDL_CreateThread(SDL_ThreadFunction fn, const char *name, void *data,
                 pfnSDL_CurrentBeginThread pfnBeginThread,
                 pfnSDL_CurrentEndThread pfnEndThread);
extern DECLSPEC SDL_Thread *SDLCALL
SDL_CreateThreadWithStackSize(SDL_ThreadFunction fn, const char *name, const size_t stacksize, void *data,
                 pfnSDL_CurrentBeginThread pfnBeginThread,
                 pfnSDL_CurrentEndThread pfnEndThread);

#if defined(SDL_CreateThread) && SDL_DYNAMIC_API
#undef SDL_CreateThread
#define SDL_CreateThread(fn, name, data) SDL_CreateThread_REAL(fn, name, data, (pfnSDL_CurrentBeginThread)SDL_beginthread, (pfnSDL_CurrentEndThread)SDL_endthread)
#undef SDL_CreateThreadWithStackSize
#define SDL_CreateThreadWithStackSize(fn, name, stacksize, data) SDL_CreateThreadWithStackSize_REAL(fn, name, stacksize, data, (pfnSDL_CurrentBeginThread)SDL_beginthread, (pfnSDL_CurrentEndThread)SDL_endthread)
#else
#define SDL_CreateThread(fn, name, data) SDL_CreateThread(fn, name, data, (pfnSDL_CurrentBeginThread)SDL_beginthread, (pfnSDL_CurrentEndThread)SDL_endthread)
#define SDL_CreateThreadWithStackSize(fn, name, stacksize, data) SDL_CreateThreadWithStackSize(fn, name, stacksize, data, (pfnSDL_CurrentBeginThread)SDL_beginthread, (pfnSDL_CurrentEndThread)SDL_endthread)
#endif

#else

/**
 * Create a new thread with a default stack size.
 *
 * This is equivalent to calling:
 *
 * ```c
 * SDL_CreateThreadWithStackSize(fn, name, 0, data);
 * ```
 *
 * \param fn the SDL_ThreadFunction function to call in the new thread.
 * \param name the name of the thread.
 * \param data a pointer that is passed to `fn`.
 * \returns an opaque pointer to the new thread object on success, NULL if the
 *          new thread could not be created; call SDL_GetError() for more
 *          information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_CreateThreadWithStackSize
 * \sa SDL_WaitThread
 */
extern DECLSPEC SDL_Thread *SDLCALL
SDL_CreateThread(SDL_ThreadFunction fn, const char *name, void *data);

/**
 * Create a new thread with a specific stack size.
 *
 * SDL makes an attempt to report `name` to the system, so that debuggers can
 * display it. Not all platforms support this.
 *
 * Thread naming is a little complicated: Most systems have very small limits
 * for the string length (Haiku has 32 bytes, Linux currently has 16, Visual
 * C++ 6.0 has _nine_!), and possibly other arbitrary rules. You'll have to
 * see what happens with your system's debugger. The name should be UTF-8 (but
 * using the naming limits of C identifiers is a better bet). There are no
 * requirements for thread naming conventions, so long as the string is
 * null-terminated UTF-8, but these guidelines are helpful in choosing a name:
 *
 * https://stackoverflow.com/questions/149932/naming-conventions-for-threads
 *
 * If a system imposes requirements, SDL will try to munge the string for it
 * (truncate, etc), but the original string contents will be available from
 * SDL_GetThreadName().
 *
 * The size (in bytes) of the new stack can be specified. Zero means "use the
 * system default" which might be wildly different between platforms. x86
 * Linux generally defaults to eight megabytes, an embedded device might be a
 * few kilobytes instead. You generally need to specify a stack that is a
 * multiple of the system's page size (in many cases, this is 4 kilobytes, but
 * check your system documentation).
 *
 * In SDL 2.1, stack size will be folded into the original SDL_CreateThread
 * function, but for backwards compatibility, this is currently a separate
 * function.
 *
 * \param fn the SDL_ThreadFunction function to call in the new thread.
 * \param name the name of the thread.
 * \param stacksize the size, in bytes, to allocate for the new thread stack.
 * \param data a pointer that is passed to `fn`.
 * \returns an opaque pointer to the new thread object on success, NULL if the
 *          new thread could not be created; call SDL_GetError() for more
 *          information.
 *
 * \since This function is available since SDL 2.0.9.
 *
 * \sa SDL_WaitThread
 */
extern DECLSPEC SDL_Thread *SDLCALL
SDL_CreateThreadWithStackSize(SDL_ThreadFunction fn, const char *name, const size_t stacksize, void *data);

#endif

/**
 * Get the thread name as it was specified in SDL_CreateThread().
 *
 * This is internal memory, not to be freed by the caller, and remains valid
 * until the specified thread is cleaned up by SDL_WaitThread().
 *
 * \param thread the thread to query.
 * \returns a pointer to a UTF-8 string that names the specified thread, or
 *          NULL if it doesn't have a name.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_CreateThread
 */
extern DECLSPEC const char *SDLCALL SDL_GetThreadName(SDL_Thread *thread);

/**
 * Get the thread identifier for the current thread.
 *
 * This thread identifier is as reported by the underlying operating system.
 * If SDL is running on a platform that does not support threads the return
 * value will always be zero.
 *
 * This function also returns a valid thread ID when called from the main
 * thread.
 *
 * \returns the ID of the current thread.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetThreadID
 */
extern DECLSPEC SDL_threadID SDLCALL SDL_ThreadID(void);

/**
 * Get the thread identifier for the specified thread.
 *
 * This thread identifier is as reported by the underlying operating system.
 * If SDL is running on a platform that does not support threads the return
 * value will always be zero.
 *
 * \param thread the thread to query.
 * \returns the ID of the specified thread, or the ID of the current thread if
 *          `thread` is NULL.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_ThreadID
 */
extern DECLSPEC SDL_threadID SDLCALL SDL_GetThreadID(SDL_Thread * thread);

/**
 * Set the priority for the current thread.
 *
 * Note that some platforms will not let you alter the priority (or at least,
 * promote the thread to a higher priority) at all, and some require you to be
 * an administrator account. Be prepared for this to fail.
 *
 * \param priority the SDL_ThreadPriority to set.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC int SDLCALL SDL_SetThreadPriority(SDL_ThreadPriority priority);

/**
 * Wait for a thread to finish.
 *
 * Threads that haven't been detached will remain (as a "zombie") until this
 * function cleans them up. Not doing so is a resource leak.
 *
 * Once a thread has been cleaned up through this function, the SDL_Thread
 * that references it becomes invalid and should not be referenced again. As
 * such, only one thread may call SDL_WaitThread() on another.
 *
 * The return code for the thread function is placed in the area pointed to by
 * `status`, if `status` is not NULL.
 *
 * You may not wait on a thread that has been used in a call to
 * SDL_DetachThread(). Use either that function or this one, but not both, or
 * behavior is undefined.
 *
 * It is safe to pass a NULL thread to this function; it is a no-op.
 *
 * Note that the thread pointer is freed by this function and is not valid
 * afterward.
 *
 * \param thread the SDL_Thread pointer that was returned from the
 *               SDL_CreateThread() call that started this thread.
 * \param status pointer to an integer that will receive the value returned
 *               from the thread function by its 'return', or NULL to not
 *               receive such value back.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_CreateThread
 * \sa SDL_DetachThread
 */
extern DECLSPEC void SDLCALL SDL_WaitThread(SDL_Thread * thread, int *status);

/**
 * Let a thread clean up on exit without intervention.
 *
 * A thread may be "detached" to signify that it should not remain until
 * another thread has called SDL_WaitThread() on it. Detaching a thread is
 * useful for long-running threads that nothing needs to synchronize with or
 * further manage. When a detached thread is done, it simply goes away.
 *
 * There is no way to recover the return code of a detached thread. If you
 * need this, don't detach the thread and instead use SDL_WaitThread().
 *
 * Once a thread is detached, you should usually assume the SDL_Thread isn't
 * safe to reference again, as it will become invalid immediately upon the
 * detached thread's exit, instead of remaining until someone has called
 * SDL_WaitThread() to finally clean it up. As such, don't detach the same
 * thread more than once.
 *
 * If a thread has already exited when passed to SDL_DetachThread(), it will
 * stop waiting for a call to SDL_WaitThread() and clean up immediately. It is
 * not safe to detach a thread that might be used with SDL_WaitThread().
 *
 * You may not call SDL_WaitThread() on a thread that has been detached. Use
 * either that function or this one, but not both, or behavior is undefined.
 *
 * It is safe to pass NULL to this function; it is a no-op.
 *
 * \param thread the SDL_Thread pointer that was returned from the
 *               SDL_CreateThread() call that started this thread.
 *
 * \since This function is available since SDL 2.0.2.
 *
 * \sa SDL_CreateThread
 * \sa SDL_WaitThread
 */
extern DECLSPEC void SDLCALL SDL_DetachThread(SDL_Thread * thread);

/**
 * Create a piece of thread-local storage.
 *
 * This creates an identifier that is globally visible to all threads but
 * refers to data that is thread-specific.
 *
 * \returns the newly created thread local storage identifier or 0 on error.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_TLSGet
 * \sa SDL_TLSSet
 */
extern DECLSPEC SDL_TLSID SDLCALL SDL_TLSCreate(void);

/**
 * Get the current thread's value associated with a thread local storage ID.
 *
 * \param id the thread local storage ID.
 * \returns the value associated with the ID for the current thread or NULL if
 *          no value has been set; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_TLSCreate
 * \sa SDL_TLSSet
 */
extern DECLSPEC void * SDLCALL SDL_TLSGet(SDL_TLSID id);

typedef void (SDLCALL *SDL_TLSDestructorCallback)(void*);

/**
 * Set the current thread's value associated with a thread local storage ID.
 *
 * The function prototype for `destructor` is:
 *
 * ```c
 * void destructor(void *value)
 * ```
 *
 * where its parameter `value` is what was passed as `value` to SDL_TLSSet().
 *
 * \param id the thread local storage ID.
 * \param value the value to associate with the ID for the current thread.
 * \param destructor a function called when the thread exits, to free the
 *                   value.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_TLSCreate
 * \sa SDL_TLSGet
 */
extern DECLSPEC int SDLCALL SDL_TLSSet(SDL_TLSID id, const void *value, SDL_TLSDestructorCallback destructor);

/**
 * Cleanup all TLS data for this thread.
 *
 * \since This function is available since SDL 2.0.16.
 */
extern DECLSPEC void SDLCALL SDL_TLSCleanup(void);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_thread_h_ */

/* vi: set ts=4 sw=4 expandtab: */
