// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*
*   Copyright (C) 2003-2013, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
*******************************************************************************
*   file name:  utrace.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2003aug06
*   created by: Markus W. Scherer
*
*   Definitions for ICU tracing/logging.
*
*/

#ifndef __UTRACE_H__
#define __UTRACE_H__

#include <stdarg.h>
#include "unicode/utypes.h"

/**
 * \file
 * \brief C API:  Definitions for ICU tracing/logging. 
 *
 * This provides API for debugging the internals of ICU without the use of
 * a traditional debugger.
 *
 * By default, tracing is disabled in ICU. If you need to debug ICU with 
 * tracing, please compile ICU with the --enable-tracing configure option.
 */
 
U_CDECL_BEGIN

/**
 * Trace severity levels.  Higher levels increase the verbosity of the trace output.
 * @see utrace_setLevel
 * @stable ICU 2.8
 */
typedef enum UTraceLevel {
    /** Disable all tracing  @stable ICU 2.8*/
    UTRACE_OFF=-1,
    /** Trace error conditions only  @stable ICU 2.8*/
    UTRACE_ERROR=0,
    /** Trace errors and warnings  @stable ICU 2.8*/
    UTRACE_WARNING=3,
    /** Trace opens and closes of ICU services  @stable ICU 2.8*/
    UTRACE_OPEN_CLOSE=5,
    /** Trace an intermediate number of ICU operations  @stable ICU 2.8*/
    UTRACE_INFO=7,
    /** Trace the maximum number of ICU operations  @stable ICU 2.8*/
    UTRACE_VERBOSE=9
} UTraceLevel;

/**
 *  These are the ICU functions that will be traced when tracing is enabled.
 *  @stable ICU 2.8
 */
typedef enum UTraceFunctionNumber {
    UTRACE_FUNCTION_START=0,
    UTRACE_U_INIT=UTRACE_FUNCTION_START,
    UTRACE_U_CLEANUP,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal collation trace location.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UTRACE_FUNCTION_LIMIT,
#endif  // U_HIDE_DEPRECATED_API

    UTRACE_CONVERSION_START=0x1000,
    UTRACE_UCNV_OPEN=UTRACE_CONVERSION_START,
    UTRACE_UCNV_OPEN_PACKAGE,
    UTRACE_UCNV_OPEN_ALGORITHMIC,
    UTRACE_UCNV_CLONE,
    UTRACE_UCNV_CLOSE,
    UTRACE_UCNV_FLUSH_CACHE,
    UTRACE_UCNV_LOAD,
    UTRACE_UCNV_UNLOAD,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal collation trace location.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UTRACE_CONVERSION_LIMIT,
#endif  // U_HIDE_DEPRECATED_API

    UTRACE_COLLATION_START=0x2000,
    UTRACE_UCOL_OPEN=UTRACE_COLLATION_START,
    UTRACE_UCOL_CLOSE,
    UTRACE_UCOL_STRCOLL,
    UTRACE_UCOL_GET_SORTKEY,
    UTRACE_UCOL_GETLOCALE,
    UTRACE_UCOL_NEXTSORTKEYPART,
    UTRACE_UCOL_STRCOLLITER,
    UTRACE_UCOL_OPEN_FROM_SHORT_STRING,
    UTRACE_UCOL_STRCOLLUTF8, /**< @stable ICU 50 */

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal collation trace location.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UTRACE_COLLATION_LIMIT,
#endif  // U_HIDE_DEPRECATED_API

    /**
     * The lowest resource/data location.
     * @stable ICU 65
     */
    UTRACE_UDATA_START=0x3000,

    /**
     * Indicates that a value was read from a resource bundle. Provides three
     * C-style strings to UTraceData: type, file name, and resource path. The
     * possible types are:
     *
     * - "string" (a string value was accessed)
     * - "binary" (a binary value was accessed)
     * - "intvector" (a integer vector value was accessed)
     * - "int" (a signed integer value was accessed)
     * - "uint" (a unsigned integer value was accessed)
     * - "get" (a path was loaded, but the value was not accessed)
     * - "getalias" (a path was loaded, and an alias was resolved)
     *
     * @stable ICU 65
     */
    UTRACE_UDATA_RESOURCE=UTRACE_UDATA_START,

    /**
     * Indicates that a resource bundle was opened.
     *
     * Provides one C-style string to UTraceData: file name.
     * @stable ICU 65
     */
    UTRACE_UDATA_BUNDLE,

    /**
     * Indicates that a data file was opened, but not *.res files.
     *
     * Provides one C-style string to UTraceData: file name.
     *
     * @stable ICU 65
     */
    UTRACE_UDATA_DATA_FILE,

    /**
     * Indicates that a *.res file was opened.
     *
     * This differs from UTRACE_UDATA_BUNDLE because a res file is typically
     * opened only once per application runtime, but the bundle corresponding
     * to that res file may be opened many times.
     *
     * Provides one C-style string to UTraceData: file name.
     *
     * @stable ICU 65
     */
    UTRACE_UDATA_RES_FILE,

#ifndef U_HIDE_INTERNAL_API
    /**
     * One more than the highest normal resource/data trace location.
     * @internal The numeric value may change over time, see ICU ticket #12420.
     */
    UTRACE_RES_DATA_LIMIT,
#endif  // U_HIDE_INTERNAL_API

    /**
     * The lowest break iterator location.
     * @stable ICU 67
     */
    UTRACE_UBRK_START=0x4000,

    /**
     * Indicates that a character instance of break iterator was created.
     *
     * @stable ICU 67
     */
    UTRACE_UBRK_CREATE_CHARACTER = UTRACE_UBRK_START,

    /**
     * Indicates that a word instance of break iterator was created.
     *
     * @stable ICU 67
     */
    UTRACE_UBRK_CREATE_WORD,

    /**
     * Indicates that a line instance of break iterator was created.
     *
     * Provides one C-style string to UTraceData: the lb value ("",
     * "loose", "strict", or "normal").
     *
     * @stable ICU 67
     */
    UTRACE_UBRK_CREATE_LINE,

    /**
     * Indicates that a sentence instance of break iterator was created.
     *
     * @stable ICU 67
     */
    UTRACE_UBRK_CREATE_SENTENCE,

    /**
     * Indicates that a title instance of break iterator was created.
     *
     * @stable ICU 67
     */
    UTRACE_UBRK_CREATE_TITLE,

    /**
     * Indicates that an internal dictionary break engine was created.
     *
     * Provides one C-style string to UTraceData: the script code of what
     * the break engine cover ("Hani", "Khmr", "Laoo", "Mymr", or "Thai").
     *
     * @stable ICU 67
     */
    UTRACE_UBRK_CREATE_BREAK_ENGINE,

#ifndef U_HIDE_INTERNAL_API
    /**
     * One more than the highest normal break iterator trace location.
     * @internal The numeric value may change over time, see ICU ticket #12420.
     */
    UTRACE_UBRK_LIMIT,
#endif  // U_HIDE_INTERNAL_API

} UTraceFunctionNumber;

/**
 * Setter for the trace level.
 * @param traceLevel A UTraceLevel value.
 * @stable ICU 2.8
 */
U_CAPI void U_EXPORT2
utrace_setLevel(int32_t traceLevel);

/**
 * Getter for the trace level.
 * @return The UTraceLevel value being used by ICU.
 * @stable ICU 2.8
 */
U_CAPI int32_t U_EXPORT2
utrace_getLevel(void);

/* Trace function pointers types  ----------------------------- */

/**
  *  Type signature for the trace function to be called when entering a function.
  *  @param context value supplied at the time the trace functions are set.
  *  @param fnNumber Enum value indicating the ICU function being entered.
  *  @stable ICU 2.8
  */
typedef void U_CALLCONV
UTraceEntry(const void *context, int32_t fnNumber);

/**
  *  Type signature for the trace function to be called when exiting from a function.
  *  @param context value supplied at the time the trace functions are set.
  *  @param fnNumber Enum value indicating the ICU function being exited.
  *  @param fmt     A formatting string that describes the number and types
  *                 of arguments included with the variable args.  The fmt
  *                 string has the same form as the utrace_vformat format
  *                 string.
  *  @param args    A variable arguments list.  Contents are described by
  *                 the fmt parameter.
  *  @see   utrace_vformat
  *  @stable ICU 2.8
  */
typedef void U_CALLCONV
UTraceExit(const void *context, int32_t fnNumber, 
           const char *fmt, va_list args);

/**
  *  Type signature for the trace function to be called from within an ICU function
  *  to display data or messages.
  *  @param context  value supplied at the time the trace functions are set.
  *  @param fnNumber Enum value indicating the ICU function being exited.
  *  @param level    The current tracing level
  *  @param fmt      A format string describing the tracing data that is supplied
  *                  as variable args
  *  @param args     The data being traced, passed as variable args.
  *  @stable ICU 2.8
  */
typedef void U_CALLCONV
UTraceData(const void *context, int32_t fnNumber, int32_t level,
           const char *fmt, va_list args);

/**
  *  Set ICU Tracing functions.  Installs application-provided tracing
  *  functions into ICU.  After doing this, subsequent ICU operations
  *  will call back to the installed functions, providing a trace
  *  of the use of ICU.  Passing a NULL pointer for a tracing function
  *  is allowed, and inhibits tracing action at points where that function
  *  would be called.
  *  <p>
  *  Tracing and Threads:  Tracing functions are global to a process, and
  *  will be called in response to ICU operations performed by any
  *  thread.  If tracing of an individual thread is desired, the
  *  tracing functions must themselves filter by checking that the
  *  current thread is the desired thread.
  *
  *  @param context an uninterpreted pointer.  Whatever is passed in
  *                 here will in turn be passed to each of the tracing
  *                 functions UTraceEntry, UTraceExit and UTraceData.
  *                 ICU does not use or alter this pointer.
  *  @param e       Callback function to be called on entry to a 
  *                 a traced ICU function.
  *  @param x       Callback function to be called on exit from a
  *                 traced ICU function.
  *  @param d       Callback function to be called from within a 
  *                 traced ICU function, for the purpose of providing
  *                 data to the trace.
  *
  *  @stable ICU 2.8
  */
U_CAPI void U_EXPORT2
utrace_setFunctions(const void *context,
                    UTraceEntry *e, UTraceExit *x, UTraceData *d);

/**
  * Get the currently installed ICU tracing functions.   Note that a null function
  *   pointer will be returned if no trace function has been set.
  *
  * @param context  The currently installed tracing context.
  * @param e        The currently installed UTraceEntry function.
  * @param x        The currently installed UTraceExit function.
  * @param d        The currently installed UTraceData function.
  * @stable ICU 2.8
  */
U_CAPI void U_EXPORT2
utrace_getFunctions(const void **context,
                    UTraceEntry **e, UTraceExit **x, UTraceData **d);



/*
 *
 * ICU trace format string syntax
 *
 * Format Strings are passed to UTraceData functions, and define the
 * number and types of the trace data being passed on each call.
 *
 * The UTraceData function, which is supplied by the application,
 * not by ICU, can either forward the trace data (passed via
 * varargs) and the format string back to ICU for formatting into
 * a displayable string, or it can interpret the format itself,
 * and do as it wishes with the trace data.
 *
 *
 * Goals for the format string
 * - basic data output
 * - easy to use for trace programmer
 * - sufficient provision for data types for trace output readability
 * - well-defined types and binary portable APIs
 *
 * Non-goals
 * - printf compatibility
 * - fancy formatting
 * - argument reordering and other internationalization features
 *
 * ICU trace format strings contain plain text with argument inserts,
 * much like standard printf format strings.
 * Each insert begins with a '%', then optionally contains a 'v',
 * then exactly one type character.
 * Two '%' in a row represent a '%' instead of an insert.
 * The trace format strings need not have \n at the end.
 *
 *
 * Types
 * -----
 *
 * Type characters:
 * - c A char character in the default codepage.
 * - s A NUL-terminated char * string in the default codepage.
 * - S A UChar * string.  Requires two params, (ptr, length).  Length=-1 for nul term.
 * - b A byte (8-bit integer).
 * - h A 16-bit integer.  Also a 16 bit Unicode code unit.
 * - d A 32-bit integer.  Also a 20 bit Unicode code point value. 
 * - l A 64-bit integer.
 * - p A data pointer.
 *
 * Vectors
 * -------
 *
 * If the 'v' is not specified, then one item of the specified type
 * is passed in.
 * If the 'v' (for "vector") is specified, then a vector of items of the
 * specified type is passed in, via a pointer to the first item
 * and an int32_t value for the length of the vector.
 * Length==-1 means zero or NUL termination.  Works for vectors of all types.
 *
 * Note:  %vS is a vector of (UChar *) strings.  The strings must
 *        be nul terminated as there is no way to provide a
 *        separate length parameter for each string.  The length
 *        parameter (required for all vectors) is the number of
 *        strings, not the length of the strings.
 *
 * Examples
 * --------
 *
 * These examples show the parameters that will be passed to an application's
 *   UTraceData() function for various formats.
 *
 * - the precise formatting is up to the application!
 * - the examples use type casts for arguments only to _show_ the types of
 *   arguments without needing variable declarations in the examples;
 *   the type casts will not be necessary in actual code
 *
 * UTraceDataFunc(context, fnNumber, level,
 *              "There is a character %c in the string %s.",   // Format String 
 *              (char)c, (const char *)s);                     // varargs parameters
 * ->   There is a character 0x42 'B' in the string "Bravo".
 *
 * UTraceDataFunc(context, fnNumber, level,
 *              "Vector of bytes %vb vector of chars %vc",
 *              (const uint8_t *)bytes, (int32_t)bytesLength,
 *              (const char *)chars, (int32_t)charsLength);
 * ->  Vector of bytes
 *      42 63 64 3f [4]
 *     vector of chars
 *      "Bcd?"[4]
 *
 * UTraceDataFunc(context, fnNumber, level,
 *              "An int32_t %d and a whole bunch of them %vd",
 *              (int32_t)-5, (const int32_t *)ints, (int32_t)intsLength);
 * ->   An int32_t 0xfffffffb and a whole bunch of them
 *      fffffffb 00000005 0000010a [3]
 *
 */



/**
  *  Trace output Formatter.  An application's UTraceData tracing functions may call
  *                 back to this function to format the trace output in a
  *                 human readable form.  Note that a UTraceData function may choose
  *                 to not format the data;  it could, for example, save it in
  *                 in the raw form it was received (more compact), leaving
  *                 formatting for a later trace analysis tool.
  *  @param outBuf  pointer to a buffer to receive the formatted output.  Output
  *                 will be nul terminated if there is space in the buffer -
  *                 if the length of the requested output < the output buffer size.
  *  @param capacity  Length of the output buffer.
  *  @param indent  Number of spaces to indent the output.  Intended to allow
  *                 data displayed from nested functions to be indented for readability.
  *  @param fmt     Format specification for the data to output
  *  @param args    Data to be formatted.
  *  @return        Length of formatted output, including the terminating NUL.
  *                 If buffer capacity is insufficient, the required capacity is returned. 
  *  @stable ICU 2.8
  */
U_CAPI int32_t U_EXPORT2
utrace_vformat(char *outBuf, int32_t capacity,
              int32_t indent, const char *fmt,  va_list args);

/**
  *  Trace output Formatter.  An application's UTraceData tracing functions may call
  *                 this function to format any additional trace data, beyond that
  *                 provided by default, in human readable form with the same
  *                 formatting conventions used by utrace_vformat().
  *  @param outBuf  pointer to a buffer to receive the formatted output.  Output
  *                 will be nul terminated if there is space in the buffer -
  *                 if the length of the requested output < the output buffer size.
  *  @param capacity  Length of the output buffer.
  *  @param indent  Number of spaces to indent the output.  Intended to allow
  *                 data displayed from nested functions to be indented for readability.
  *  @param fmt     Format specification for the data to output
  *  @param ...     Data to be formatted.
  *  @return        Length of formatted output, including the terminating NUL.
  *                 If buffer capacity is insufficient, the required capacity is returned. 
  *  @stable ICU 2.8
  */
U_CAPI int32_t U_EXPORT2
utrace_format(char *outBuf, int32_t capacity,
              int32_t indent, const char *fmt,  ...);



/* Trace function numbers --------------------------------------------------- */

/**
 * Get the name of a function from its trace function number.
 *
 * @param fnNumber The trace number for an ICU function.
 * @return The name string for the function.
 *
 * @see UTraceFunctionNumber
 * @stable ICU 2.8
 */
U_CAPI const char * U_EXPORT2
utrace_functionName(int32_t fnNumber);

U_CDECL_END

#endif
