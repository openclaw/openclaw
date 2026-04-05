// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*  
**********************************************************************
*   Copyright (C) 2002-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
*   file name:  uconfig.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2002sep19
*   created by: Markus W. Scherer
*/

#ifndef __UCONFIG_H__
#define __UCONFIG_H__


/*!
 * \file
 * \brief User-configurable settings
 *
 * Miscellaneous switches:
 *
 * A number of macros affect a variety of minor aspects of ICU.
 * Most of them used to be defined elsewhere (e.g., in utypes.h or platform.h)
 * and moved here to make them easier to find.
 *
 * Switches for excluding parts of ICU library code modules:
 *
 * Changing these macros allows building partial, smaller libraries for special purposes.
 * By default, all modules are built.
 * The switches are fairly coarse, controlling large modules.
 * Basic services cannot be turned off.
 *
 * Building with any of these options does not guarantee that the
 * ICU build process will completely work. It is recommended that
 * the ICU libraries and data be built using the normal build.
 * At that time you should remove the data used by those services.
 * After building the ICU data library, you should rebuild the ICU
 * libraries with these switches customized to your needs.
 *
 * @stable ICU 2.4
 */

/**
 * If this switch is defined, ICU will attempt to load a header file named "uconfig_local.h"
 * prior to determining default settings for uconfig variables.
 *
 * @internal ICU 4.0
 */
#if defined(UCONFIG_USE_LOCAL)
#include "uconfig_local.h"
#endif

/**
 * \def U_DEBUG
 * Determines whether to include debugging code.
 * Automatically set on Windows, but most compilers do not have
 * related predefined macros.
 * @internal
 */
#ifdef U_DEBUG
    /* Use the predefined value. */
#elif defined(_DEBUG)
    /*
     * _DEBUG is defined by Visual Studio debug compilation.
     * Do *not* test for its NDEBUG macro: It is an orthogonal macro
     * which disables assert().
     */
#   define U_DEBUG 1
# else
#   define U_DEBUG 0
#endif

/**
 * Determines whether to enable auto cleanup of libraries. 
 * @internal
 */
#ifndef UCLN_NO_AUTO_CLEANUP
#define UCLN_NO_AUTO_CLEANUP 1
#endif

/**
 * \def U_DISABLE_RENAMING
 * Determines whether to disable renaming or not.
 * @internal
 */
#ifndef U_DISABLE_RENAMING
#define U_DISABLE_RENAMING 0
#endif

/**
 * \def U_NO_DEFAULT_INCLUDE_UTF_HEADERS
 * Determines whether utypes.h includes utf.h, utf8.h, utf16.h and utf_old.h.
 * utypes.h includes those headers if this macro is defined to 0.
 * Otherwise, each those headers must be included explicitly when using one of their macros.
 * Defaults to 0 for backward compatibility, except inside ICU.
 * @stable ICU 49
 */
#ifdef U_NO_DEFAULT_INCLUDE_UTF_HEADERS
    /* Use the predefined value. */
#elif defined(U_COMBINED_IMPLEMENTATION) || defined(U_COMMON_IMPLEMENTATION) || defined(U_I18N_IMPLEMENTATION) || \
      defined(U_IO_IMPLEMENTATION) || defined(U_LAYOUT_IMPLEMENTATION) || defined(U_LAYOUTEX_IMPLEMENTATION) || \
      defined(U_TOOLUTIL_IMPLEMENTATION)
#   define U_NO_DEFAULT_INCLUDE_UTF_HEADERS 1
#else
#   define U_NO_DEFAULT_INCLUDE_UTF_HEADERS 0
#endif

/**
 * \def U_OVERRIDE_CXX_ALLOCATION
 * Determines whether to override new and delete.
 * ICU is normally built such that all of its C++ classes, via their UMemory base,
 * override operators new and delete to use its internal, customizable,
 * non-exception-throwing memory allocation functions. (Default value 1 for this macro.)
 *
 * This is especially important when the application and its libraries use multiple heaps.
 * For example, on Windows, this allows the ICU DLL to be used by
 * applications that statically link the C Runtime library.
 *
 * @stable ICU 2.2
 */
#ifndef U_OVERRIDE_CXX_ALLOCATION
#define U_OVERRIDE_CXX_ALLOCATION 1
#endif

/**
 * \def U_ENABLE_TRACING
 * Determines whether to enable tracing.
 * @internal
 */
#ifndef U_ENABLE_TRACING
#define U_ENABLE_TRACING 0
#endif

/**
 * \def UCONFIG_ENABLE_PLUGINS
 * Determines whether to enable ICU plugins.
 * @internal
 */
#ifndef UCONFIG_ENABLE_PLUGINS
#define UCONFIG_ENABLE_PLUGINS 0
#endif

/**
 * \def U_ENABLE_DYLOAD
 * Whether to enable Dynamic loading in ICU.
 * @internal
 */
#ifndef U_ENABLE_DYLOAD
#define U_ENABLE_DYLOAD 1
#endif

/**
 * \def U_CHECK_DYLOAD
 * Whether to test Dynamic loading as an OS capability.
 * @internal
 */
#ifndef U_CHECK_DYLOAD
#define U_CHECK_DYLOAD 1
#endif

/**
 * \def U_DEFAULT_SHOW_DRAFT
 * Do we allow ICU users to use the draft APIs by default?
 * @internal
 */
#ifndef U_DEFAULT_SHOW_DRAFT
#define U_DEFAULT_SHOW_DRAFT 1
#endif

/*===========================================================================*/
/* Custom icu entry point renaming                                           */
/*===========================================================================*/

/**
 * \def U_HAVE_LIB_SUFFIX
 * 1 if a custom library suffix is set.
 * @internal
 */
#ifdef U_HAVE_LIB_SUFFIX
    /* Use the predefined value. */
#elif defined(U_LIB_SUFFIX_C_NAME) || defined(U_IN_DOXYGEN)
#   define U_HAVE_LIB_SUFFIX 1
#endif

/**
 * \def U_LIB_SUFFIX_C_NAME_STRING
 * Defines the library suffix as a string with C syntax.
 * @internal
 */
#ifdef U_LIB_SUFFIX_C_NAME_STRING
    /* Use the predefined value. */
#elif defined(U_LIB_SUFFIX_C_NAME)
#   define CONVERT_TO_STRING(s) #s
#   define U_LIB_SUFFIX_C_NAME_STRING CONVERT_TO_STRING(U_LIB_SUFFIX_C_NAME)
#else
#   define U_LIB_SUFFIX_C_NAME_STRING ""
#endif

/* common/i18n library switches --------------------------------------------- */

/**
 * \def UCONFIG_ONLY_COLLATION
 * This switch turns off modules that are not needed for collation.
 *
 * It does not turn off legacy conversion because that is necessary
 * for ICU to work on EBCDIC platforms (for the default converter).
 * If you want "only collation" and do not build for EBCDIC,
 * then you can define UCONFIG_NO_CONVERSION or UCONFIG_NO_LEGACY_CONVERSION to 1 as well.
 *
 * @stable ICU 2.4
 */
#ifndef UCONFIG_ONLY_COLLATION
#   define UCONFIG_ONLY_COLLATION 0
#endif

#if UCONFIG_ONLY_COLLATION
    /* common library */
#   define UCONFIG_NO_BREAK_ITERATION 1
#   define UCONFIG_NO_IDNA 1

    /* i18n library */
#   if UCONFIG_NO_COLLATION
#       error Contradictory collation switches in uconfig.h.
#   endif
#   define UCONFIG_NO_FORMATTING 1
#   define UCONFIG_NO_TRANSLITERATION 1
#   define UCONFIG_NO_REGULAR_EXPRESSIONS 1
#endif

/* common library switches -------------------------------------------------- */

/**
 * \def UCONFIG_NO_FILE_IO
 * This switch turns off all file access in the common library
 * where file access is only used for data loading.
 * ICU data must then be provided in the form of a data DLL (or with an
 * equivalent way to link to the data residing in an executable,
 * as in building a combined library with both the common library's code and
 * the data), or via udata_setCommonData().
 * Application data must be provided via udata_setAppData() or by using
 * "open" functions that take pointers to data, for example ucol_openBinary().
 *
 * File access is not used at all in the i18n library.
 *
 * File access cannot be turned off for the icuio library or for the ICU
 * test suites and ICU tools.
 *
 * @stable ICU 3.6
 */
#ifndef UCONFIG_NO_FILE_IO
#   define UCONFIG_NO_FILE_IO 0
#endif

#if UCONFIG_NO_FILE_IO && defined(U_TIMEZONE_FILES_DIR) 
#   error Contradictory file io switches in uconfig.h.
#endif

/**
 * \def UCONFIG_NO_CONVERSION
 * ICU will not completely build (compiling the tools fails) with this
 * switch turned on.
 * This switch turns off all converters.
 *
 * You may want to use this together with U_CHARSET_IS_UTF8 defined to 1
 * in utypes.h if char* strings in your environment are always in UTF-8.
 *
 * @stable ICU 3.2
 * @see U_CHARSET_IS_UTF8
 */
#ifndef UCONFIG_NO_CONVERSION
#   define UCONFIG_NO_CONVERSION 0
#endif

#if UCONFIG_NO_CONVERSION
#   define UCONFIG_NO_LEGACY_CONVERSION 1
#endif

/**
 * \def UCONFIG_ONLY_HTML_CONVERSION
 * This switch turns off all of the converters NOT listed in
 * the HTML encoding standard:
 * http://www.w3.org/TR/encoding/#names-and-labels
 *
 * This is not possible on EBCDIC platforms
 * because they need ibm-37 or ibm-1047 default converters.
 *
 * @stable ICU 55
 */
#ifndef UCONFIG_ONLY_HTML_CONVERSION
#   define UCONFIG_ONLY_HTML_CONVERSION 0
#endif

/**
 * \def UCONFIG_NO_LEGACY_CONVERSION
 * This switch turns off all converters except for
 * - Unicode charsets (UTF-7/8/16/32, CESU-8, SCSU, BOCU-1)
 * - US-ASCII
 * - ISO-8859-1
 *
 * Turning off legacy conversion is not possible on EBCDIC platforms
 * because they need ibm-37 or ibm-1047 default converters.
 *
 * @stable ICU 2.4
 */
#ifndef UCONFIG_NO_LEGACY_CONVERSION
#   define UCONFIG_NO_LEGACY_CONVERSION 0
#endif

/**
 * \def UCONFIG_NO_NORMALIZATION
 * This switch turns off normalization.
 * It implies turning off several other services as well, for example
 * collation and IDNA.
 *
 * @stable ICU 2.6
 */
#ifndef UCONFIG_NO_NORMALIZATION
#   define UCONFIG_NO_NORMALIZATION 0
#endif

/**
 * \def UCONFIG_USE_ML_PHRASE_BREAKING
 * This switch turns on BudouX ML phrase-based line breaking, rather than using the dictionary.
 *
 * @internal
 */
#ifndef UCONFIG_USE_ML_PHRASE_BREAKING
#   define UCONFIG_USE_ML_PHRASE_BREAKING 0
#endif

#if UCONFIG_NO_NORMALIZATION
    /* common library */
    /* ICU 50 CJK dictionary BreakIterator uses normalization */
#   define UCONFIG_NO_BREAK_ITERATION 1
    /* IDNA (UTS #46) is implemented via normalization */
#   define UCONFIG_NO_IDNA 1

    /* i18n library */
#   if UCONFIG_ONLY_COLLATION
#       error Contradictory collation switches in uconfig.h.
#   endif
#   define UCONFIG_NO_COLLATION 1
#   define UCONFIG_NO_TRANSLITERATION 1
#endif

/**
 * \def UCONFIG_NO_BREAK_ITERATION
 * This switch turns off break iteration.
 *
 * @stable ICU 2.4
 */
#ifndef UCONFIG_NO_BREAK_ITERATION
#   define UCONFIG_NO_BREAK_ITERATION 0
#endif

/**
 * \def UCONFIG_NO_IDNA
 * This switch turns off IDNA.
 *
 * @stable ICU 2.6
 */
#ifndef UCONFIG_NO_IDNA
#   define UCONFIG_NO_IDNA 0
#endif

/**
 * \def UCONFIG_MSGPAT_DEFAULT_APOSTROPHE_MODE
 * Determines the default UMessagePatternApostropheMode.
 * See the documentation for that enum.
 *
 * @stable ICU 4.8
 */
#ifndef UCONFIG_MSGPAT_DEFAULT_APOSTROPHE_MODE
#   define UCONFIG_MSGPAT_DEFAULT_APOSTROPHE_MODE UMSGPAT_APOS_DOUBLE_OPTIONAL
#endif

/**
 * \def UCONFIG_USE_WINDOWS_LCID_MAPPING_API
 * On platforms where U_PLATFORM_HAS_WIN32_API is true, this switch determines
 * if the Windows platform APIs are used for LCID<->Locale Name conversions.
 * Otherwise, only the built-in ICU tables are used.
 * 
 * @internal ICU 64
 */
#ifndef UCONFIG_USE_WINDOWS_LCID_MAPPING_API
#   define UCONFIG_USE_WINDOWS_LCID_MAPPING_API 1
#endif

/* i18n library switches ---------------------------------------------------- */

/**
 * \def UCONFIG_NO_COLLATION
 * This switch turns off collation and collation-based string search.
 *
 * @stable ICU 2.4
 */
#ifndef UCONFIG_NO_COLLATION
#   define UCONFIG_NO_COLLATION 0
#endif

/**
 * \def UCONFIG_NO_FORMATTING
 * This switch turns off formatting and calendar/timezone services.
 *
 * @stable ICU 2.4
 */
#ifndef UCONFIG_NO_FORMATTING
#   define UCONFIG_NO_FORMATTING 0
#endif

/**
 * \def UCONFIG_NO_MF2
 * This switch turns off the experimental MessageFormat 2.0 API.
 *
 * @internal ICU 75 technology preview
 * @deprecated This API is for technology preview only.
 */
#ifndef UCONFIG_NO_MF2
#   define UCONFIG_NO_MF2 0
#endif

/**
 * \def UCONFIG_NO_TRANSLITERATION
 * This switch turns off transliteration.
 *
 * @stable ICU 2.4
 */
#ifndef UCONFIG_NO_TRANSLITERATION
#   define UCONFIG_NO_TRANSLITERATION 0
#endif

/**
 * \def UCONFIG_NO_REGULAR_EXPRESSIONS
 * This switch turns off regular expressions.
 *
 * @stable ICU 2.4
 */
#ifndef UCONFIG_NO_REGULAR_EXPRESSIONS
#   define UCONFIG_NO_REGULAR_EXPRESSIONS 0
#endif

/**
 * \def UCONFIG_NO_SERVICE
 * This switch turns off service registration.
 *
 * @stable ICU 3.2
 */
#ifndef UCONFIG_NO_SERVICE
#   define UCONFIG_NO_SERVICE 0
#endif

/**
 * \def UCONFIG_HAVE_PARSEALLINPUT
 * This switch turns on the "parse all input" attribute. Binary incompatible.
 *
 * @internal
 */
#ifndef UCONFIG_HAVE_PARSEALLINPUT
#   define UCONFIG_HAVE_PARSEALLINPUT 1
#endif

/**
 * \def UCONFIG_NO_FILTERED_BREAK_ITERATION
 * This switch turns off filtered break iteration code.
 *
 * @internal
 */
#ifndef UCONFIG_NO_FILTERED_BREAK_ITERATION
#   define UCONFIG_NO_FILTERED_BREAK_ITERATION 0
#endif

#endif  // __UCONFIG_H__
