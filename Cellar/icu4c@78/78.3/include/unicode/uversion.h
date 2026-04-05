// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*   Copyright (C) 2000-2011, International Business Machines
*   Corporation and others.  All Rights Reserved.
*******************************************************************************
*
*   file name:  uversion.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   Created by: Vladimir Weinstein
*
*  Gets included by utypes.h and Windows .rc files
*/

/**
 * \file
 * \brief C API: API for accessing ICU version numbers. 
 */
/*===========================================================================*/
/* Main ICU version information                                              */
/*===========================================================================*/

#ifndef UVERSION_H
#define UVERSION_H

#include "unicode/umachine.h"

/* Actual version info lives in uvernum.h */
#include "unicode/uvernum.h"

/** Maximum length of the copyright string.
 *  @stable ICU 2.4
 */
#define U_COPYRIGHT_STRING_LENGTH  128

/** An ICU version consists of up to 4 numbers from 0..255.
 *  @stable ICU 2.4
 */
#define U_MAX_VERSION_LENGTH 4

/** In a string, ICU version fields are delimited by dots.
 *  @stable ICU 2.4
 */
#define U_VERSION_DELIMITER '.'

/** The maximum length of an ICU version string.
 *  @stable ICU 2.4
 */
#define U_MAX_VERSION_STRING_LENGTH 20

/** The binary form of a version on ICU APIs is an array of 4 uint8_t.
 *  To compare two versions, use memcmp(v1,v2,sizeof(UVersionInfo)).
 *  @stable ICU 2.4
 */
typedef uint8_t UVersionInfo[U_MAX_VERSION_LENGTH];

/*===========================================================================*/
/* C++ namespace if supported. Versioned unless versioning is disabled.      */
/*===========================================================================*/

/* Define C++ namespace symbols. */
#ifdef __cplusplus

/**
 * \def U_NAMESPACE_BEGIN
 * This is used to begin a declaration of a public ICU C++ API within
 * versioned-ICU-namespace block.
 *
 * @stable ICU 2.4
 */

/**
 * \def U_NAMESPACE_END
 * This is used to end a declaration of a public ICU C++ API.
 * It ends the versioned-ICU-namespace block begun by U_NAMESPACE_BEGIN.
 *
 * @stable ICU 2.4
 */

/**
 * \def U_NAMESPACE_USE
 * This is used to specify that the rest of the code uses the
 * public ICU C++ API namespace.
 * @stable ICU 2.4
 */

/**
 * \def U_NAMESPACE_QUALIFIER
 * This is used to qualify that a function or class is part of
 * the public ICU C++ API namespace.
 *
 * This macro is unnecessary since ICU 49 requires namespace support.
 * You can just use "icu::" instead.
 * @stable ICU 2.4
 */

#   if U_DISABLE_RENAMING
#       define U_ICU_NAMESPACE icu
        namespace U_ICU_NAMESPACE { }
#   else
#       define U_ICU_NAMESPACE U_ICU_ENTRY_POINT_RENAME(icu)
        namespace U_ICU_NAMESPACE { }
        namespace icu = U_ICU_NAMESPACE;
#   endif

#   define U_NAMESPACE_BEGIN namespace U_ICU_NAMESPACE {
#   define U_NAMESPACE_END }
#   define U_NAMESPACE_USE using namespace U_ICU_NAMESPACE;
#   define U_NAMESPACE_QUALIFIER U_ICU_NAMESPACE::

#   ifndef U_USING_ICU_NAMESPACE
#       if defined(U_COMBINED_IMPLEMENTATION) || defined(U_COMMON_IMPLEMENTATION) || \
                defined(U_I18N_IMPLEMENTATION) || defined(U_IO_IMPLEMENTATION) || \
                defined(U_LAYOUTEX_IMPLEMENTATION) || defined(U_TOOLUTIL_IMPLEMENTATION)
#           define U_USING_ICU_NAMESPACE 0
#       else
#           define U_USING_ICU_NAMESPACE 0
#       endif
#   endif
#   if U_USING_ICU_NAMESPACE
        U_NAMESPACE_USE
#   endif

/**
 * \def U_HEADER_NESTED_NAMESPACE
 * Nested namespace used inside U_ICU_NAMESPACE for header-only APIs.
 * Different when used inside ICU to prevent public use of internal instantiations:
 * "header" when compiling calling code; "internal" when compiling ICU library code.
 *
 * When compiling for Windows, where DLL exports of APIs are explicit,
 * this is always "header". Header-only types are not marked for export,
 * which on Windows already avoids callers linking with library instantiations.
 *
 * @stable ICU 76
 * @see U_HEADER_ONLY_NAMESPACE
 */

/**
 * \def U_HEADER_ONLY_NAMESPACE
 * Namespace used for header-only APIs.
 * Different when used inside ICU to prevent public use of internal instantiations.
 * "U_ICU_NAMESPACE::header" or "U_ICU_NAMESPACE::internal",
 * see U_HEADER_NESTED_NAMESPACE for details.
 *
 * @stable ICU 76
 */

#ifndef U_FORCE_HIDE_DRAFT_API
/**
 * \def U_ICU_NAMESPACE_OR_INTERNAL
 * Namespace used for header-only APIs that used to be regular C++ APIs.
 * Different when used inside ICU to prevent public use of internal instantiations.
 * Similar to U_HEADER_ONLY_NAMESPACE, but the public definition is the same as U_ICU_NAMESPACE.
 * "U_ICU_NAMESPACE" or "U_ICU_NAMESPACE::internal".
 *
 * @draft ICU 77
 */
#endif  // U_FORCE_HIDE_DRAFT_API

// The first test is the same as for defining U_EXPORT for Windows.
#if defined(_MSC_VER) || (UPRV_HAS_DECLSPEC_ATTRIBUTE(__dllexport__) && \
                          UPRV_HAS_DECLSPEC_ATTRIBUTE(__dllimport__))
#   define U_HEADER_NESTED_NAMESPACE header
#   define U_ICU_NAMESPACE_OR_INTERNAL U_ICU_NAMESPACE
#elif defined(U_COMBINED_IMPLEMENTATION) || defined(U_COMMON_IMPLEMENTATION) || \
        defined(U_I18N_IMPLEMENTATION) || defined(U_IO_IMPLEMENTATION) || \
        defined(U_LAYOUTEX_IMPLEMENTATION) || defined(U_TOOLUTIL_IMPLEMENTATION)
#   define U_HEADER_NESTED_NAMESPACE internal
#   define U_ICU_NAMESPACE_OR_INTERNAL U_ICU_NAMESPACE::internal
    namespace U_ICU_NAMESPACE_OR_INTERNAL {}
    using namespace U_ICU_NAMESPACE_OR_INTERNAL;
#else
#   define U_HEADER_NESTED_NAMESPACE header
#   define U_ICU_NAMESPACE_OR_INTERNAL U_ICU_NAMESPACE
#endif

#define U_HEADER_ONLY_NAMESPACE U_ICU_NAMESPACE::U_HEADER_NESTED_NAMESPACE

namespace U_HEADER_ONLY_NAMESPACE {}

#endif /* __cplusplus */

/*===========================================================================*/
/* General version helper functions. Definitions in putil.c                  */
/*===========================================================================*/

/**
 * Parse a string with dotted-decimal version information and
 * fill in a UVersionInfo structure with the result.
 * Definition of this function lives in putil.c
 *
 * @param versionArray The destination structure for the version information.
 * @param versionString A string with dotted-decimal version information,
 *                      with up to four non-negative number fields with
 *                      values of up to 255 each.
 * @stable ICU 2.4
 */
U_CAPI void U_EXPORT2
u_versionFromString(UVersionInfo versionArray, const char *versionString);

/**
 * Parse a Unicode string with dotted-decimal version information and
 * fill in a UVersionInfo structure with the result.
 * Definition of this function lives in putil.c
 *
 * @param versionArray The destination structure for the version information.
 * @param versionString A Unicode string with dotted-decimal version
 *                      information, with up to four non-negative number
 *                      fields with values of up to 255 each.
 * @stable ICU 4.2
 */
U_CAPI void U_EXPORT2
u_versionFromUString(UVersionInfo versionArray, const UChar *versionString);


/**
 * Write a string with dotted-decimal version information according
 * to the input UVersionInfo.
 * Definition of this function lives in putil.c
 *
 * @param versionArray The version information to be written as a string.
 * @param versionString A string buffer that will be filled in with
 *                      a string corresponding to the numeric version
 *                      information in versionArray.
 *                      The buffer size must be at least U_MAX_VERSION_STRING_LENGTH.
 * @stable ICU 2.4
 */
U_CAPI void U_EXPORT2
u_versionToString(const UVersionInfo versionArray, char *versionString);

/**
 * Gets the ICU release version.  The version array stores the version information
 * for ICU.  For example, release "1.3.31.2" is then represented as 0x01031F02.
 * Definition of this function lives in putil.c
 *
 * @param versionArray the version # information, the result will be filled in
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
u_getVersion(UVersionInfo versionArray);
#endif
