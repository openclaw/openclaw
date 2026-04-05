/*
 * Copyright 2019-2025 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_MACROS_H
#define OPENSSL_MACROS_H
#pragma once

#include <openssl/opensslconf.h>
#include <openssl/opensslv.h>

/* Helper macros for CPP string composition */
#define OPENSSL_MSTR_HELPER(x) #x
#define OPENSSL_MSTR(x) OPENSSL_MSTR_HELPER(x)

/*
 * Sometimes OPENSSL_NO_xxx ends up with an empty file and some compilers
 * don't like that.  This will hopefully silence them.
 */
#define NON_EMPTY_TRANSLATION_UNIT static void *dummy = &dummy;

/*
 * Generic deprecation macro
 *
 * If OPENSSL_SUPPRESS_DEPRECATED is defined, then OSSL_DEPRECATED and
 * OSSL_DEPRECATED_FOR become no-ops
 */
#ifndef OSSL_DEPRECATED
#undef OSSL_DEPRECATED_FOR
#ifndef OPENSSL_SUPPRESS_DEPRECATED
#if defined(_MSC_VER)
/*
 * MSVC supports __declspec(deprecated) since MSVC 2003 (13.10),
 * and __declspec(deprecated(message)) since MSVC 2005 (14.00)
 */
#if _MSC_VER >= 1400
#define OSSL_DEPRECATED(since) \
    __declspec(deprecated("Since OpenSSL " #since))
#define OSSL_DEPRECATED_FOR(since, message) \
    __declspec(deprecated("Since OpenSSL " #since ";" message))
#elif _MSC_VER >= 1310
#define OSSL_DEPRECATED(since) __declspec(deprecated)
#define OSSL_DEPRECATED_FOR(since, message) __declspec(deprecated)
#endif
#elif defined(__GNUC__)
/*
 * According to GCC documentation, deprecations with message appeared in
 * GCC 4.5.0
 */
#if __GNUC__ > 4 || (__GNUC__ == 4 && __GNUC_MINOR__ >= 5)
#define OSSL_DEPRECATED(since) \
    __attribute__((deprecated("Since OpenSSL " #since)))
#define OSSL_DEPRECATED_FOR(since, message) \
    __attribute__((deprecated("Since OpenSSL " #since ";" message)))
#elif __GNUC__ > 3 || (__GNUC__ == 3 && __GNUC_MINOR__ > 0)
#define OSSL_DEPRECATED(since) __attribute__((deprecated))
#define OSSL_DEPRECATED_FOR(since, message) __attribute__((deprecated))
#endif
#elif defined(__SUNPRO_C)
#if (__SUNPRO_C >= 0x5130)
#define OSSL_DEPRECATED(since) __attribute__((deprecated))
#define OSSL_DEPRECATED_FOR(since, message) __attribute__((deprecated))
#endif
#endif
#endif
#endif

/*
 * Still not defined?  Then define no-op macros. This means these macros
 * are unsuitable for use in a typedef.
 */
#ifndef OSSL_DEPRECATED
#define OSSL_DEPRECATED(since) extern
#define OSSL_DEPRECATED_FOR(since, message) extern
#endif

/*
 * Applications should use -DOPENSSL_API_COMPAT=<version> to suppress the
 * declarations of functions deprecated in or before <version>.  If this is
 * undefined, the value of the macro OPENSSL_CONFIGURED_API (defined in
 * <openssl/opensslconf.h>) is the default.
 *
 * For any version number up until version 1.1.x, <version> is expected to be
 * the calculated version number 0xMNNFFPPSL.
 * For version numbers 3.0 and on, <version> is expected to be a computation
 * of the major and minor numbers in decimal using this formula:
 *
 *     MAJOR * 10000 + MINOR * 100
 *
 * So version 3.0 becomes 30000, version 3.2 becomes 30200, etc.
 */

/*
 * We use the OPENSSL_API_COMPAT value to define API level macros.  These
 * macros are used to enable or disable features at that API version boundary.
 */

#ifdef OPENSSL_API_LEVEL
#error "OPENSSL_API_LEVEL must not be defined by application"
#endif

/*
 * We figure out what API level was intended by simple numeric comparison.
 * The lowest old style number we recognise is 0x00908000L, so we take some
 * safety margin and assume that anything below 0x00900000L is a new style
 * number.  This allows new versions up to and including v943.71.83.
 */
#ifdef OPENSSL_API_COMPAT
#if OPENSSL_API_COMPAT < 0x900000L
#define OPENSSL_API_LEVEL (OPENSSL_API_COMPAT)
#else
#define OPENSSL_API_LEVEL                           \
    (((OPENSSL_API_COMPAT >> 28) & 0xF) * 10000     \
        + ((OPENSSL_API_COMPAT >> 20) & 0xFF) * 100 \
        + ((OPENSSL_API_COMPAT >> 12) & 0xFF))
#endif
#endif

/*
 * If OPENSSL_API_COMPAT wasn't given, we use default numbers to set
 * the API compatibility level.
 */
#ifndef OPENSSL_API_LEVEL
#if OPENSSL_CONFIGURED_API > 0
#define OPENSSL_API_LEVEL (OPENSSL_CONFIGURED_API)
#else
#define OPENSSL_API_LEVEL \
    (OPENSSL_VERSION_MAJOR * 10000 + OPENSSL_VERSION_MINOR * 100)
#endif
#endif

#if OPENSSL_API_LEVEL > OPENSSL_CONFIGURED_API
#error "The requested API level higher than the configured API compatibility level"
#endif

/*
 * Check of sane values.
 */
/* Can't go higher than the current version. */
#if OPENSSL_API_LEVEL > (OPENSSL_VERSION_MAJOR * 10000 + OPENSSL_VERSION_MINOR * 100)
#error "OPENSSL_API_COMPAT expresses an impossible API compatibility level"
#endif
/* OpenSSL will have no version 2.y.z */
#if OPENSSL_API_LEVEL < 30000 && OPENSSL_API_LEVEL >= 20000
#error "OPENSSL_API_COMPAT expresses an impossible API compatibility level"
#endif
/* Below 0.9.8 is unacceptably low */
#if OPENSSL_API_LEVEL < 908
#error "OPENSSL_API_COMPAT expresses an impossible API compatibility level"
#endif

/*
 * Define macros for deprecation and simulated removal purposes.
 *
 * The macros OSSL_DEPRECATEDIN_{major}_{minor} are always defined for
 * all OpenSSL versions we care for.  They can be used as attributes
 * in function declarations where appropriate.
 *
 * The macros OPENSSL_NO_DEPRECATED_{major}_{minor} are defined for
 * all OpenSSL versions up to or equal to the version given with
 * OPENSSL_API_COMPAT.  They are used as guards around anything that's
 * deprecated up to that version, as an effect of the developer option
 * 'no-deprecated'.
 */

#undef OPENSSL_NO_DEPRECATED_3_6
#undef OPENSSL_NO_DEPRECATED_3_4
#undef OPENSSL_NO_DEPRECATED_3_1
#undef OPENSSL_NO_DEPRECATED_3_0
#undef OPENSSL_NO_DEPRECATED_1_1_1
#undef OPENSSL_NO_DEPRECATED_1_1_0
#undef OPENSSL_NO_DEPRECATED_1_0_2
#undef OPENSSL_NO_DEPRECATED_1_0_1
#undef OPENSSL_NO_DEPRECATED_1_0_0
#undef OPENSSL_NO_DEPRECATED_0_9_8

#if OPENSSL_API_LEVEL >= 30600
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_3_6 OSSL_DEPRECATED(3.6)
#define OSSL_DEPRECATEDIN_3_6_FOR(msg) OSSL_DEPRECATED_FOR(3.6, msg)
#else
#define OPENSSL_NO_DEPRECATED_3_6
#endif
#else
#define OSSL_DEPRECATEDIN_3_6
#define OSSL_DEPRECATEDIN_3_6_FOR(msg)
#endif
#if OPENSSL_API_LEVEL >= 30500
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_3_5 OSSL_DEPRECATED(3.5)
#define OSSL_DEPRECATEDIN_3_5_FOR(msg) OSSL_DEPRECATED_FOR(3.5, msg)
#else
#define OPENSSL_NO_DEPRECATED_3_5
#endif
#else
#define OSSL_DEPRECATEDIN_3_5
#define OSSL_DEPRECATEDIN_3_5_FOR(msg)
#endif
#if OPENSSL_API_LEVEL >= 30400
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_3_4 OSSL_DEPRECATED(3.4)
#define OSSL_DEPRECATEDIN_3_4_FOR(msg) OSSL_DEPRECATED_FOR(3.4, msg)
#else
#define OPENSSL_NO_DEPRECATED_3_4
#endif
#else
#define OSSL_DEPRECATEDIN_3_4
#define OSSL_DEPRECATEDIN_3_4_FOR(msg)
#endif
#if OPENSSL_API_LEVEL >= 30100
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_3_1 OSSL_DEPRECATED(3.1)
#define OSSL_DEPRECATEDIN_3_1_FOR(msg) OSSL_DEPRECATED_FOR(3.1, msg)
#else
#define OPENSSL_NO_DEPRECATED_3_1
#endif
#else
#define OSSL_DEPRECATEDIN_3_1
#define OSSL_DEPRECATEDIN_3_1_FOR(msg)
#endif
#if OPENSSL_API_LEVEL >= 30000
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_3_0 OSSL_DEPRECATED(3.0)
#define OSSL_DEPRECATEDIN_3_0_FOR(msg) OSSL_DEPRECATED_FOR(3.0, msg)
#else
#define OPENSSL_NO_DEPRECATED_3_0
#endif
#else
#define OSSL_DEPRECATEDIN_3_0
#define OSSL_DEPRECATEDIN_3_0_FOR(msg)
#endif
#if OPENSSL_API_LEVEL >= 10101
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_1_1_1 OSSL_DEPRECATED(1.1.1)
#define OSSL_DEPRECATEDIN_1_1_1_FOR(msg) OSSL_DEPRECATED_FOR(1.1.1, msg)
#else
#define OPENSSL_NO_DEPRECATED_1_1_1
#endif
#else
#define OSSL_DEPRECATEDIN_1_1_1
#define OSSL_DEPRECATEDIN_1_1_1_FOR(msg)
#endif
#if OPENSSL_API_LEVEL >= 10100
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_1_1_0 OSSL_DEPRECATED(1.1.0)
#define OSSL_DEPRECATEDIN_1_1_0_FOR(msg) OSSL_DEPRECATED_FOR(1.1.0, msg)
#else
#define OPENSSL_NO_DEPRECATED_1_1_0
#endif
#else
#define OSSL_DEPRECATEDIN_1_1_0
#define OSSL_DEPRECATEDIN_1_1_0_FOR(msg)
#endif
#if OPENSSL_API_LEVEL >= 10002
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_1_0_2 OSSL_DEPRECATED(1.0.2)
#define OSSL_DEPRECATEDIN_1_0_2_FOR(msg) OSSL_DEPRECATED_FOR(1.0.2, msg)
#else
#define OPENSSL_NO_DEPRECATED_1_0_2
#endif
#else
#define OSSL_DEPRECATEDIN_1_0_2
#define OSSL_DEPRECATEDIN_1_0_2_FOR(msg)
#endif
#if OPENSSL_API_LEVEL >= 10001
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_1_0_1 OSSL_DEPRECATED(1.0.1)
#define OSSL_DEPRECATEDIN_1_0_1_FOR(msg) OSSL_DEPRECATED_FOR(1.0.1, msg)
#else
#define OPENSSL_NO_DEPRECATED_1_0_1
#endif
#else
#define OSSL_DEPRECATEDIN_1_0_1
#define OSSL_DEPRECATEDIN_1_0_1_FOR(msg)
#endif
#if OPENSSL_API_LEVEL >= 10000
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_1_0_0 OSSL_DEPRECATED(1.0.0)
#define OSSL_DEPRECATEDIN_1_0_0_FOR(msg) OSSL_DEPRECATED_FOR(1.0.0, msg)
#else
#define OPENSSL_NO_DEPRECATED_1_0_0
#endif
#else
#define OSSL_DEPRECATEDIN_1_0_0
#define OSSL_DEPRECATEDIN_1_0_0_FOR(msg)
#endif
#if OPENSSL_API_LEVEL >= 908
#ifndef OPENSSL_NO_DEPRECATED
#define OSSL_DEPRECATEDIN_0_9_8 OSSL_DEPRECATED(0.9.8)
#define OSSL_DEPRECATEDIN_0_9_8_FOR(msg) OSSL_DEPRECATED_FOR(0.9.8, msg)
#else
#define OPENSSL_NO_DEPRECATED_0_9_8
#endif
#else
#define OSSL_DEPRECATEDIN_0_9_8
#define OSSL_DEPRECATEDIN_0_9_8_FOR(msg)
#endif

/*
 * Make our own variants of __FILE__ and __LINE__, depending on configuration
 */

#ifndef OPENSSL_FILE
#ifdef OPENSSL_NO_FILENAMES
#define OPENSSL_FILE ""
#define OPENSSL_LINE 0
#else
#define OPENSSL_FILE __FILE__
#define OPENSSL_LINE __LINE__
#endif
#endif

/*
 * __func__ was standardized in C99, so for any compiler that claims
 * to implement that language level or newer, we assume we can safely
 * use that symbol.
 *
 * GNU C also provides __FUNCTION__ since version 2, which predates
 * C99.  We can, however, only use this if __STDC_VERSION__ exists,
 * as it's otherwise not allowed according to ISO C standards (C90).
 * (compiling with GNU C's -pedantic tells us so)
 *
 * If none of the above applies, we check if the compiler is MSVC,
 * and use __FUNCTION__ if that's the case.
 */
#ifndef OPENSSL_FUNC
#if defined(__STDC_VERSION__)
#if __STDC_VERSION__ >= 199901L
#define OPENSSL_FUNC __func__
#elif defined(__GNUC__) && __GNUC__ >= 2
#define OPENSSL_FUNC __FUNCTION__
#endif
#elif defined(_MSC_VER)
#define OPENSSL_FUNC __FUNCTION__
#endif
/*
 * If all these possibilities are exhausted, we give up and use a
 * static string.
 */
#ifndef OPENSSL_FUNC
#define OPENSSL_FUNC "(unknown function)"
#endif
#endif

#ifndef OSSL_CRYPTO_ALLOC
#if defined(__GNUC__)
#define OSSL_CRYPTO_ALLOC __attribute__((__malloc__))
#elif defined(_MSC_VER)
#define OSSL_CRYPTO_ALLOC __declspec(restrict)
#else
#define OSSL_CRYPTO_ALLOC
#endif
#endif

#endif /* OPENSSL_MACROS_H */
