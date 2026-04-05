// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
*
*   Copyright (C) 1997-2014, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
******************************************************************************
*
*  FILE NAME : putil.h
*
*   Date        Name        Description
*   05/14/98    nos         Creation (content moved here from utypes.h).
*   06/17/99    erm         Added IEEE_754
*   07/22/98    stephen     Added IEEEremainder, max, min, trunc
*   08/13/98    stephen     Added isNegativeInfinity, isPositiveInfinity
*   08/24/98    stephen     Added longBitsFromDouble
*   03/02/99    stephen     Removed openFile().  Added AS400 support.
*   04/15/99    stephen     Converted to C
*   11/15/99    helena      Integrated S/390 changes for IEEE support.
*   01/11/00    helena      Added u_getVersion.
******************************************************************************
*/

#ifndef PUTIL_H
#define PUTIL_H

#include "unicode/utypes.h"
 /**
  * \file
  * \brief C API: Platform Utilities
  */

/*==========================================================================*/
/* Platform utilities                                                       */
/*==========================================================================*/

/**
 * Platform utilities isolates the platform dependencies of the
 * library.  For each platform which this code is ported to, these
 * functions may have to be re-implemented.
 */

/**
 * Return the ICU data directory. 
 * The data directory is where common format ICU data files (.dat files)
 *   are loaded from.  Note that normal use of the built-in ICU
 *   facilities does not require loading of an external data file;
 *   unless you are adding custom data to ICU, the data directory
 *   does not need to be set.
 *
 * The data directory is determined as follows:
 *    If u_setDataDirectory() has been called, that is it, otherwise
 *    if the ICU_DATA environment variable is set, use that, otherwise
 *    If a data directory was specified at ICU build time
 *      <code>
 * \code
 *        #define ICU_DATA_DIR "path" 
 * \endcode
 * </code> use that,
 *    otherwise no data directory is available.
 *
 * @return the data directory, or an empty string ("") if no data directory has
 *         been specified.
 *   
 * @stable ICU 2.0
 */
U_CAPI const char* U_EXPORT2 u_getDataDirectory(void);


/** 
 * Set the ICU data directory. 
 * The data directory is where common format ICU data files (.dat files)
 *   are loaded from.  Note that normal use of the built-in ICU
 *   facilities does not require loading of an external data file;
 *   unless you are adding custom data to ICU, the data directory
 *   does not need to be set.
 *
 * This function should be called at most once in a process, before the
 * first ICU operation (e.g., u_init()) that will require the loading of an
 * ICU data file.
 * This function is not thread-safe. Use it before calling ICU APIs from
 * multiple threads.
 *
 * @param directory The directory to be set.
 *
 * @see u_init
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 u_setDataDirectory(const char *directory);

#ifndef U_HIDE_INTERNAL_API
/**
  * Return the time zone files override directory, or an empty string if
  * no directory was specified. Certain time zone resources will be preferentially
  * loaded from individual files in this directory.
  *
  * @return the time zone data override directory.
  * @internal
  */ 
U_CAPI const char * U_EXPORT2 u_getTimeZoneFilesDirectory(UErrorCode *status);

/**
  * Set the time zone files override directory.
  * This function is not thread safe; it must not be called concurrently with
  *   u_getTimeZoneFilesDirectory() or any other use of ICU time zone functions.
  * This function should only be called before using any ICU service that
  *   will access the time zone data.
  * @internal
  */
U_CAPI void U_EXPORT2 u_setTimeZoneFilesDirectory(const char *path, UErrorCode *status);
#endif  /* U_HIDE_INTERNAL_API */


/**
 * @{
 * Filesystem file and path separator characters.
 * Example: '/' and ':' on Unix, '\\' and ';' on Windows.
 * @stable ICU 2.0
 */
#if U_PLATFORM_USES_ONLY_WIN32_API
#   define U_FILE_SEP_CHAR '\\'
#   define U_FILE_ALT_SEP_CHAR '/'
#   define U_PATH_SEP_CHAR ';'
#   define U_FILE_SEP_STRING "\\"
#   define U_FILE_ALT_SEP_STRING "/"
#   define U_PATH_SEP_STRING ";"
#else
#   define U_FILE_SEP_CHAR '/'
#   define U_FILE_ALT_SEP_CHAR '/'
#   define U_PATH_SEP_CHAR ':'
#   define U_FILE_SEP_STRING "/"
#   define U_FILE_ALT_SEP_STRING "/"
#   define U_PATH_SEP_STRING ":"
#endif

/** @} */

/**
 * Convert char characters to UChar characters.
 * This utility function is useful only for "invariant characters"
 * that are encoded in the platform default encoding.
 * They are a small, constant subset of the encoding and include
 * just the latin letters, digits, and some punctuation.
 * For details, see U_CHARSET_FAMILY.
 *
 * @param cs Input string, points to <code>length</code>
 *           character bytes from a subset of the platform encoding.
 * @param us Output string, points to memory for <code>length</code>
 *           Unicode characters.
 * @param length The number of characters to convert; this may
 *               include the terminating <code>NUL</code>.
 *
 * @see U_CHARSET_FAMILY
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
u_charsToUChars(const char *cs, UChar *us, int32_t length);

/**
 * Convert UChar characters to char characters.
 * This utility function is useful only for "invariant characters"
 * that can be encoded in the platform default encoding.
 * They are a small, constant subset of the encoding and include
 * just the latin letters, digits, and some punctuation.
 * For details, see U_CHARSET_FAMILY.
 *
 * @param us Input string, points to <code>length</code>
 *           Unicode characters that can be encoded with the
 *           codepage-invariant subset of the platform encoding.
 * @param cs Output string, points to memory for <code>length</code>
 *           character bytes.
 * @param length The number of characters to convert; this may
 *               include the terminating <code>NUL</code>.
 *
 * @see U_CHARSET_FAMILY
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
u_UCharsToChars(const UChar *us, char *cs, int32_t length);

#endif
