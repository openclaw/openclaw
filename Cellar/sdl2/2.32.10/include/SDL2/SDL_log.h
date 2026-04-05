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
 * # CategoryLog
 *
 * Simple log messages with categories and priorities.
 *
 * By default logs are quiet, but if you're debugging SDL you might want:
 *
 * SDL_LogSetAllPriority(SDL_LOG_PRIORITY_WARN);
 *
 * Here's where the messages go on different platforms:
 *
 * - Windows: debug output stream
 * - Android: log output
 * - Others: standard error output (stderr)
 */

#ifndef SDL_log_h_
#define SDL_log_h_

#include "SDL_stdinc.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif


/**
 * The maximum size of a log message prior to SDL 2.0.24
 *
 * As of 2.0.24 there is no limit to the length of SDL log messages.
 */
#define SDL_MAX_LOG_MESSAGE 4096

/**
 * The predefined log categories
 *
 * By default the application category is enabled at the INFO level, the
 * assert category is enabled at the WARN level, test is enabled at the
 * VERBOSE level and all other categories are enabled at the ERROR level.
 */
typedef enum SDL_LogCategory
{
    SDL_LOG_CATEGORY_APPLICATION,
    SDL_LOG_CATEGORY_ERROR,
    SDL_LOG_CATEGORY_ASSERT,
    SDL_LOG_CATEGORY_SYSTEM,
    SDL_LOG_CATEGORY_AUDIO,
    SDL_LOG_CATEGORY_VIDEO,
    SDL_LOG_CATEGORY_RENDER,
    SDL_LOG_CATEGORY_INPUT,
    SDL_LOG_CATEGORY_TEST,

    /* Reserved for future SDL library use */
    SDL_LOG_CATEGORY_RESERVED1,
    SDL_LOG_CATEGORY_RESERVED2,
    SDL_LOG_CATEGORY_RESERVED3,
    SDL_LOG_CATEGORY_RESERVED4,
    SDL_LOG_CATEGORY_RESERVED5,
    SDL_LOG_CATEGORY_RESERVED6,
    SDL_LOG_CATEGORY_RESERVED7,
    SDL_LOG_CATEGORY_RESERVED8,
    SDL_LOG_CATEGORY_RESERVED9,
    SDL_LOG_CATEGORY_RESERVED10,

    /* Beyond this point is reserved for application use, e.g.
       enum {
           MYAPP_CATEGORY_AWESOME1 = SDL_LOG_CATEGORY_CUSTOM,
           MYAPP_CATEGORY_AWESOME2,
           MYAPP_CATEGORY_AWESOME3,
           ...
       };
     */
    SDL_LOG_CATEGORY_CUSTOM
} SDL_LogCategory;

/**
 * The predefined log priorities
 */
typedef enum SDL_LogPriority
{
    SDL_LOG_PRIORITY_VERBOSE = 1,
    SDL_LOG_PRIORITY_DEBUG,
    SDL_LOG_PRIORITY_INFO,
    SDL_LOG_PRIORITY_WARN,
    SDL_LOG_PRIORITY_ERROR,
    SDL_LOG_PRIORITY_CRITICAL,
    SDL_NUM_LOG_PRIORITIES
} SDL_LogPriority;


/**
 * Set the priority of all log categories.
 *
 * \param priority the SDL_LogPriority to assign.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_LogSetPriority
 */
extern DECLSPEC void SDLCALL SDL_LogSetAllPriority(SDL_LogPriority priority);

/**
 * Set the priority of a particular log category.
 *
 * \param category the category to assign a priority to.
 * \param priority the SDL_LogPriority to assign.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_LogGetPriority
 * \sa SDL_LogSetAllPriority
 */
extern DECLSPEC void SDLCALL SDL_LogSetPriority(int category,
                                                SDL_LogPriority priority);

/**
 * Get the priority of a particular log category.
 *
 * \param category the category to query.
 * \returns the SDL_LogPriority for the requested category.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_LogSetPriority
 */
extern DECLSPEC SDL_LogPriority SDLCALL SDL_LogGetPriority(int category);

/**
 * Reset all priorities to default.
 *
 * This is called by SDL_Quit().
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_LogSetAllPriority
 * \sa SDL_LogSetPriority
 */
extern DECLSPEC void SDLCALL SDL_LogResetPriorities(void);

/**
 * Log a message with SDL_LOG_CATEGORY_APPLICATION and SDL_LOG_PRIORITY_INFO.
 *
 * = * \param fmt a printf() style message format string
 *
 * \param ... additional parameters matching % tokens in the `fmt` string, if
 *            any.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_LogCritical
 * \sa SDL_LogDebug
 * \sa SDL_LogError
 * \sa SDL_LogInfo
 * \sa SDL_LogMessage
 * \sa SDL_LogMessageV
 * \sa SDL_LogVerbose
 * \sa SDL_LogWarn
 */
extern DECLSPEC void SDLCALL SDL_Log(SDL_PRINTF_FORMAT_STRING const char *fmt, ...) SDL_PRINTF_VARARG_FUNC(1);

/**
 * Log a message with SDL_LOG_PRIORITY_VERBOSE.
 *
 * \param category the category of the message.
 * \param fmt a printf() style message format string.
 * \param ... additional parameters matching % tokens in the **fmt** string,
 *            if any.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Log
 * \sa SDL_LogCritical
 * \sa SDL_LogDebug
 * \sa SDL_LogError
 * \sa SDL_LogInfo
 * \sa SDL_LogMessage
 * \sa SDL_LogMessageV
 * \sa SDL_LogWarn
 */
extern DECLSPEC void SDLCALL SDL_LogVerbose(int category, SDL_PRINTF_FORMAT_STRING const char *fmt, ...) SDL_PRINTF_VARARG_FUNC(2);

/**
 * Log a message with SDL_LOG_PRIORITY_DEBUG.
 *
 * \param category the category of the message.
 * \param fmt a printf() style message format string.
 * \param ... additional parameters matching % tokens in the **fmt** string,
 *            if any.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Log
 * \sa SDL_LogCritical
 * \sa SDL_LogError
 * \sa SDL_LogInfo
 * \sa SDL_LogMessage
 * \sa SDL_LogMessageV
 * \sa SDL_LogVerbose
 * \sa SDL_LogWarn
 */
extern DECLSPEC void SDLCALL SDL_LogDebug(int category, SDL_PRINTF_FORMAT_STRING const char *fmt, ...) SDL_PRINTF_VARARG_FUNC(2);

/**
 * Log a message with SDL_LOG_PRIORITY_INFO.
 *
 * \param category the category of the message.
 * \param fmt a printf() style message format string.
 * \param ... additional parameters matching % tokens in the **fmt** string,
 *            if any.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Log
 * \sa SDL_LogCritical
 * \sa SDL_LogDebug
 * \sa SDL_LogError
 * \sa SDL_LogMessage
 * \sa SDL_LogMessageV
 * \sa SDL_LogVerbose
 * \sa SDL_LogWarn
 */
extern DECLSPEC void SDLCALL SDL_LogInfo(int category, SDL_PRINTF_FORMAT_STRING const char *fmt, ...) SDL_PRINTF_VARARG_FUNC(2);

/**
 * Log a message with SDL_LOG_PRIORITY_WARN.
 *
 * \param category the category of the message.
 * \param fmt a printf() style message format string.
 * \param ... additional parameters matching % tokens in the **fmt** string,
 *            if any.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Log
 * \sa SDL_LogCritical
 * \sa SDL_LogDebug
 * \sa SDL_LogError
 * \sa SDL_LogInfo
 * \sa SDL_LogMessage
 * \sa SDL_LogMessageV
 * \sa SDL_LogVerbose
 */
extern DECLSPEC void SDLCALL SDL_LogWarn(int category, SDL_PRINTF_FORMAT_STRING const char *fmt, ...) SDL_PRINTF_VARARG_FUNC(2);

/**
 * Log a message with SDL_LOG_PRIORITY_ERROR.
 *
 * \param category the category of the message.
 * \param fmt a printf() style message format string.
 * \param ... additional parameters matching % tokens in the **fmt** string,
 *            if any.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Log
 * \sa SDL_LogCritical
 * \sa SDL_LogDebug
 * \sa SDL_LogInfo
 * \sa SDL_LogMessage
 * \sa SDL_LogMessageV
 * \sa SDL_LogVerbose
 * \sa SDL_LogWarn
 */
extern DECLSPEC void SDLCALL SDL_LogError(int category, SDL_PRINTF_FORMAT_STRING const char *fmt, ...) SDL_PRINTF_VARARG_FUNC(2);

/**
 * Log a message with SDL_LOG_PRIORITY_CRITICAL.
 *
 * \param category the category of the message.
 * \param fmt a printf() style message format string.
 * \param ... additional parameters matching % tokens in the **fmt** string,
 *            if any.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Log
 * \sa SDL_LogDebug
 * \sa SDL_LogError
 * \sa SDL_LogInfo
 * \sa SDL_LogMessage
 * \sa SDL_LogMessageV
 * \sa SDL_LogVerbose
 * \sa SDL_LogWarn
 */
extern DECLSPEC void SDLCALL SDL_LogCritical(int category, SDL_PRINTF_FORMAT_STRING const char *fmt, ...) SDL_PRINTF_VARARG_FUNC(2);

/**
 * Log a message with the specified category and priority.
 *
 * \param category the category of the message.
 * \param priority the priority of the message.
 * \param fmt a printf() style message format string.
 * \param ... additional parameters matching % tokens in the **fmt** string,
 *            if any.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Log
 * \sa SDL_LogCritical
 * \sa SDL_LogDebug
 * \sa SDL_LogError
 * \sa SDL_LogInfo
 * \sa SDL_LogMessageV
 * \sa SDL_LogVerbose
 * \sa SDL_LogWarn
 */
extern DECLSPEC void SDLCALL SDL_LogMessage(int category,
                                            SDL_LogPriority priority,
                                            SDL_PRINTF_FORMAT_STRING const char *fmt, ...) SDL_PRINTF_VARARG_FUNC(3);

/**
 * Log a message with the specified category and priority.
 *
 * \param category the category of the message.
 * \param priority the priority of the message.
 * \param fmt a printf() style message format string.
 * \param ap a variable argument list.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Log
 * \sa SDL_LogCritical
 * \sa SDL_LogDebug
 * \sa SDL_LogError
 * \sa SDL_LogInfo
 * \sa SDL_LogMessage
 * \sa SDL_LogVerbose
 * \sa SDL_LogWarn
 */
extern DECLSPEC void SDLCALL SDL_LogMessageV(int category,
                                             SDL_LogPriority priority,
                                             SDL_PRINTF_FORMAT_STRING const char *fmt, va_list ap) SDL_PRINTF_VARARG_FUNCV(3);

/**
 * The prototype for the log output callback function.
 *
 * This function is called by SDL when there is new text to be logged.
 *
 * \param userdata what was passed as `userdata` to
 *                 SDL_LogSetOutputFunction().
 * \param category the category of the message.
 * \param priority the priority of the message.
 * \param message the message being output.
 */
typedef void (SDLCALL *SDL_LogOutputFunction)(void *userdata, int category, SDL_LogPriority priority, const char *message);

/**
 * Get the current log output function.
 *
 * \param callback an SDL_LogOutputFunction filled in with the current log
 *                 callback.
 * \param userdata a pointer filled in with the pointer that is passed to
 *                 `callback`.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_LogSetOutputFunction
 */
extern DECLSPEC void SDLCALL SDL_LogGetOutputFunction(SDL_LogOutputFunction *callback, void **userdata);

/**
 * Replace the default log output function with one of your own.
 *
 * \param callback an SDL_LogOutputFunction to call instead of the default.
 * \param userdata a pointer that is passed to `callback`.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_LogGetOutputFunction
 */
extern DECLSPEC void SDLCALL SDL_LogSetOutputFunction(SDL_LogOutputFunction callback, void *userdata);


/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_log_h_ */

/* vi: set ts=4 sw=4 expandtab: */
