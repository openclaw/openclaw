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

#ifndef SDL_assert_h_
#define SDL_assert_h_

#include "SDL_stdinc.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

#ifndef SDL_ASSERT_LEVEL
#ifdef SDL_DEFAULT_ASSERT_LEVEL
#define SDL_ASSERT_LEVEL SDL_DEFAULT_ASSERT_LEVEL
#elif defined(_DEBUG) || defined(DEBUG) || \
      (defined(__GNUC__) && !defined(__OPTIMIZE__))
#define SDL_ASSERT_LEVEL 2
#else
#define SDL_ASSERT_LEVEL 1
#endif
#endif /* SDL_ASSERT_LEVEL */

/*
These are macros and not first class functions so that the debugger breaks
on the assertion line and not in some random guts of SDL, and so each
assert can have unique static variables associated with it.
*/

#if defined(_MSC_VER)
/* Don't include intrin.h here because it contains C++ code */
    extern void __cdecl __debugbreak(void);
    #define SDL_TriggerBreakpoint() __debugbreak()
#elif _SDL_HAS_BUILTIN(__builtin_debugtrap)
    #define SDL_TriggerBreakpoint() __builtin_debugtrap()
#elif ( (!defined(__NACL__)) && ((defined(__GNUC__) || defined(__clang__)) && (defined(__i386__) || defined(__x86_64__))) )
    #define SDL_TriggerBreakpoint() __asm__ __volatile__ ( "int $3\n\t" )
#elif (defined(__GNUC__) || defined(__clang__)) && defined(__riscv)
    #define SDL_TriggerBreakpoint() __asm__ __volatile__ ( "ebreak\n\t" )
#elif ( defined(__APPLE__) && (defined(__arm64__) || defined(__aarch64__)) )  /* this might work on other ARM targets, but this is a known quantity... */
    #define SDL_TriggerBreakpoint() __asm__ __volatile__ ( "brk #22\n\t" )
#elif defined(__APPLE__) && defined(__arm__)
    #define SDL_TriggerBreakpoint() __asm__ __volatile__ ( "bkpt #22\n\t" )
#elif defined(_WIN32) && ((defined(__GNUC__) || defined(__clang__)) && (defined(__arm64__) || defined(__aarch64__)) )
    #define SDL_TriggerBreakpoint() __asm__ __volatile__ ( "brk #0xF000\n\t" )
#elif defined(__386__) && defined(__WATCOMC__)
    #define SDL_TriggerBreakpoint() { _asm { int 0x03 } }
#elif defined(HAVE_SIGNAL_H) && !defined(__WATCOMC__)
    #include <signal.h>
    #define SDL_TriggerBreakpoint() raise(SIGTRAP)
#else
    /* How do we trigger breakpoints on this platform? */
    #define SDL_TriggerBreakpoint()
#endif

#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L) /* C99 supports __func__ as a standard. */
#   define SDL_FUNCTION __func__
#elif ((defined(__GNUC__) && (__GNUC__ >= 2)) || defined(_MSC_VER) || defined (__WATCOMC__))
#   define SDL_FUNCTION __FUNCTION__
#else
#   define SDL_FUNCTION "???"
#endif
#define SDL_FILE    __FILE__
#define SDL_LINE    __LINE__

/*
sizeof (x) makes the compiler still parse the expression even without
assertions enabled, so the code is always checked at compile time, but
doesn't actually generate code for it, so there are no side effects or
expensive checks at run time, just the constant size of what x WOULD be,
which presumably gets optimized out as unused.
This also solves the problem of...

    int somevalue = blah();
    SDL_assert(somevalue == 1);

...which would cause compiles to complain that somevalue is unused if we
disable assertions.
*/

/* "while (0,0)" fools Microsoft's compiler's /W4 warning level into thinking
    this condition isn't constant. And looks like an owl's face! */
#ifdef _MSC_VER  /* stupid /W4 warnings. */
#define SDL_NULL_WHILE_LOOP_CONDITION (0,0)
#else
#define SDL_NULL_WHILE_LOOP_CONDITION (0)
#endif

#define SDL_disabled_assert(condition) \
    do { (void) sizeof ((condition)); } while (SDL_NULL_WHILE_LOOP_CONDITION)

typedef enum
{
    SDL_ASSERTION_RETRY,  /**< Retry the assert immediately. */
    SDL_ASSERTION_BREAK,  /**< Make the debugger trigger a breakpoint. */
    SDL_ASSERTION_ABORT,  /**< Terminate the program. */
    SDL_ASSERTION_IGNORE,  /**< Ignore the assert. */
    SDL_ASSERTION_ALWAYS_IGNORE  /**< Ignore the assert from now on. */
} SDL_AssertState;

typedef struct SDL_AssertData
{
    int always_ignore;
    unsigned int trigger_count;
    const char *condition;
    const char *filename;
    int linenum;
    const char *function;
    const struct SDL_AssertData *next;
} SDL_AssertData;

/* Never call this directly. Use the SDL_assert* macros. */
extern DECLSPEC SDL_AssertState SDLCALL SDL_ReportAssertion(SDL_AssertData *,
                                                            const char *,
                                                            const char *, int)
#if defined(__clang__)
#if __has_feature(attribute_analyzer_noreturn)
/* this tells Clang's static analysis that we're a custom assert function,
   and that the analyzer should assume the condition was always true past this
   SDL_assert test. */
   __attribute__((analyzer_noreturn))
#endif
#endif
;

/* the do {} while(0) avoids dangling else problems:
    if (x) SDL_assert(y); else blah();
       ... without the do/while, the "else" could attach to this macro's "if".
   We try to handle just the minimum we need here in a macro...the loop,
   the static vars, and break points. The heavy lifting is handled in
   SDL_ReportAssertion(), in SDL_assert.c.
*/
#define SDL_enabled_assert(condition) \
    do { \
        while ( !(condition) ) { \
            static struct SDL_AssertData sdl_assert_data = { 0, 0, #condition, NULL, 0, NULL, NULL }; \
            const SDL_AssertState sdl_assert_state = SDL_ReportAssertion(&sdl_assert_data, SDL_FUNCTION, SDL_FILE, SDL_LINE); \
            if (sdl_assert_state == SDL_ASSERTION_RETRY) { \
                continue; /* go again. */ \
            } else if (sdl_assert_state == SDL_ASSERTION_BREAK) { \
                SDL_TriggerBreakpoint(); \
            } \
            break; /* not retrying. */ \
        } \
    } while (SDL_NULL_WHILE_LOOP_CONDITION)

/* Enable various levels of assertions. */
#if SDL_ASSERT_LEVEL == 0   /* assertions disabled */
#   define SDL_assert(condition) SDL_disabled_assert(condition)
#   define SDL_assert_release(condition) SDL_disabled_assert(condition)
#   define SDL_assert_paranoid(condition) SDL_disabled_assert(condition)
#elif SDL_ASSERT_LEVEL == 1  /* release settings. */
#   define SDL_assert(condition) SDL_disabled_assert(condition)
#   define SDL_assert_release(condition) SDL_enabled_assert(condition)
#   define SDL_assert_paranoid(condition) SDL_disabled_assert(condition)
#elif SDL_ASSERT_LEVEL == 2  /* normal settings. */
#   define SDL_assert(condition) SDL_enabled_assert(condition)
#   define SDL_assert_release(condition) SDL_enabled_assert(condition)
#   define SDL_assert_paranoid(condition) SDL_disabled_assert(condition)
#elif SDL_ASSERT_LEVEL == 3  /* paranoid settings. */
#   define SDL_assert(condition) SDL_enabled_assert(condition)
#   define SDL_assert_release(condition) SDL_enabled_assert(condition)
#   define SDL_assert_paranoid(condition) SDL_enabled_assert(condition)
#else
#   error Unknown assertion level.
#endif

/* this assertion is never disabled at any level. */
#define SDL_assert_always(condition) SDL_enabled_assert(condition)


/**
 * A callback that fires when an SDL assertion fails.
 *
 * \param data a pointer to the SDL_AssertData structure corresponding to the
 *             current assertion.
 * \param userdata what was passed as `userdata` to SDL_SetAssertionHandler().
 * \returns an SDL_AssertState value indicating how to handle the failure.
 */
typedef SDL_AssertState (SDLCALL *SDL_AssertionHandler)(
                                 const SDL_AssertData* data, void* userdata);

/**
 * Set an application-defined assertion handler.
 *
 * This function allows an application to show its own assertion UI and/or
 * force the response to an assertion failure. If the application doesn't
 * provide this, SDL will try to do the right thing, popping up a
 * system-specific GUI dialog, and probably minimizing any fullscreen windows.
 *
 * This callback may fire from any thread, but it runs wrapped in a mutex, so
 * it will only fire from one thread at a time.
 *
 * This callback is NOT reset to SDL's internal handler upon SDL_Quit()!
 *
 * \param handler the SDL_AssertionHandler function to call when an assertion
 *                fails or NULL for the default handler.
 * \param userdata a pointer that is passed to `handler`.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetAssertionHandler
 */
extern DECLSPEC void SDLCALL SDL_SetAssertionHandler(
                                            SDL_AssertionHandler handler,
                                            void *userdata);

/**
 * Get the default assertion handler.
 *
 * This returns the function pointer that is called by default when an
 * assertion is triggered. This is an internal function provided by SDL, that
 * is used for assertions when SDL_SetAssertionHandler() hasn't been used to
 * provide a different function.
 *
 * \returns the default SDL_AssertionHandler that is called when an assert
 *          triggers.
 *
 * \since This function is available since SDL 2.0.2.
 *
 * \sa SDL_GetAssertionHandler
 */
extern DECLSPEC SDL_AssertionHandler SDLCALL SDL_GetDefaultAssertionHandler(void);

/**
 * Get the current assertion handler.
 *
 * This returns the function pointer that is called when an assertion is
 * triggered. This is either the value last passed to
 * SDL_SetAssertionHandler(), or if no application-specified function is set,
 * is equivalent to calling SDL_GetDefaultAssertionHandler().
 *
 * The parameter `puserdata` is a pointer to a void*, which will store the
 * "userdata" pointer that was passed to SDL_SetAssertionHandler(). This value
 * will always be NULL for the default handler. If you don't care about this
 * data, it is safe to pass a NULL pointer to this function to ignore it.
 *
 * \param puserdata pointer which is filled with the "userdata" pointer that
 *                  was passed to SDL_SetAssertionHandler().
 * \returns the SDL_AssertionHandler that is called when an assert triggers.
 *
 * \since This function is available since SDL 2.0.2.
 *
 * \sa SDL_SetAssertionHandler
 */
extern DECLSPEC SDL_AssertionHandler SDLCALL SDL_GetAssertionHandler(void **puserdata);

/**
 * Get a list of all assertion failures.
 *
 * This function gets all assertions triggered since the last call to
 * SDL_ResetAssertionReport(), or the start of the program.
 *
 * The proper way to examine this data looks something like this:
 *
 * ```c
 * const SDL_AssertData *item = SDL_GetAssertionReport();
 * while (item) {
 *    printf("'%s', %s (%s:%d), triggered %u times, always ignore: %s.\\n",
 *           item->condition, item->function, item->filename,
 *           item->linenum, item->trigger_count,
 *           item->always_ignore ? "yes" : "no");
 *    item = item->next;
 * }
 * ```
 *
 * \returns a list of all failed assertions or NULL if the list is empty. This
 *          memory should not be modified or freed by the application.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_ResetAssertionReport
 */
extern DECLSPEC const SDL_AssertData * SDLCALL SDL_GetAssertionReport(void);

/**
 * Clear the list of all assertion failures.
 *
 * This function will clear the list of all assertions triggered up to that
 * point. Immediately following this call, SDL_GetAssertionReport will return
 * no items. In addition, any previously-triggered assertions will be reset to
 * a trigger_count of zero, and their always_ignore state will be false.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_GetAssertionReport
 */
extern DECLSPEC void SDLCALL SDL_ResetAssertionReport(void);


/* these had wrong naming conventions until 2.0.4. Please update your app! */
#define SDL_assert_state SDL_AssertState
#define SDL_assert_data SDL_AssertData


/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_assert_h_ */

/* vi: set ts=4 sw=4 expandtab: */
