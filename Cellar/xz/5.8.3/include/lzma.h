/* SPDX-License-Identifier: 0BSD */

/**
 * \file        api/lzma.h
 * \brief       The public API of liblzma data compression library
 * \mainpage
 *
 * liblzma is a general-purpose data compression library with a zlib-like API.
 * The native file format is .xz, but also the old .lzma format and raw (no
 * headers) streams are supported. Multiple compression algorithms (filters)
 * are supported. Currently LZMA2 is the primary filter.
 *
 * liblzma is part of XZ Utils <https://tukaani.org/xz/>. XZ Utils
 * includes a gzip-like command line tool named xz and some other tools.
 * XZ Utils is developed and maintained by Lasse Collin.
 *
 * Major parts of liblzma are based on code written by Igor Pavlov,
 * specifically the LZMA SDK <https://7-zip.org/sdk.html>.
 *
 * The SHA-256 implementation in liblzma is based on code written by
 * Wei Dai in Crypto++ Library <https://www.cryptopp.com/>.
 *
 * liblzma is distributed under the BSD Zero Clause License (0BSD).
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H
#define LZMA_H

/*****************************
 * Required standard headers *
 *****************************/

/*
 * liblzma API headers need some standard types and macros. To allow
 * including lzma.h without requiring the application to include other
 * headers first, lzma.h includes the required standard headers unless
 * they already seem to be included already or if LZMA_MANUAL_HEADERS
 * has been defined.
 *
 * Here's what types and macros are needed and from which headers:
 *  - stddef.h: size_t, NULL
 *  - stdint.h: uint8_t, uint32_t, uint64_t, UINT32_C(n), uint64_C(n),
 *    UINT32_MAX, UINT64_MAX
 *
 * However, inttypes.h is a little more portable than stdint.h, although
 * inttypes.h declares some unneeded things compared to plain stdint.h.
 *
 * The hacks below aren't perfect, specifically they assume that inttypes.h
 * exists and that it typedefs at least uint8_t, uint32_t, and uint64_t,
 * and that, in case of incomplete inttypes.h, unsigned int is 32-bit.
 * If the application already takes care of setting up all the types and
 * macros properly (for example by using gnulib's stdint.h or inttypes.h),
 * we try to detect that the macros are already defined and don't include
 * inttypes.h here again. However, you may define LZMA_MANUAL_HEADERS to
 * force this file to never include any system headers.
 *
 * Some could argue that liblzma API should provide all the required types,
 * for example lzma_uint64, LZMA_UINT64_C(n), and LZMA_UINT64_MAX. This was
 * seen as an unnecessary mess, since most systems already provide all the
 * necessary types and macros in the standard headers.
 *
 * Note that liblzma API still has lzma_bool, because using stdbool.h would
 * break C89 and C++ programs on many systems. sizeof(bool) in C99 isn't
 * necessarily the same as sizeof(bool) in C++.
 */

#ifndef LZMA_MANUAL_HEADERS
	/*
	 * I suppose this works portably also in C++. Note that in C++,
	 * we need to get size_t into the global namespace.
	 */
#	include <stddef.h>

	/*
	 * Skip inttypes.h if we already have all the required macros. If we
	 * have the macros, we assume that we have the matching typedefs too.
	 */
#	if !defined(UINT32_C) || !defined(UINT64_C) \
			|| !defined(UINT32_MAX) || !defined(UINT64_MAX)
		/*
		 * MSVC versions older than 2013 have no C99 support, and
		 * thus they cannot be used to compile liblzma. Using an
		 * existing liblzma.dll with old MSVC can work though(*),
		 * but we need to define the required standard integer
		 * types here in a MSVC-specific way.
		 *
		 * (*) If you do this, the existing liblzma.dll probably uses
		 *     a different runtime library than your MSVC-built
		 *     application. Mixing runtimes is generally bad, but
		 *     in this case it should work as long as you avoid
		 *     the few rarely-needed liblzma functions that allocate
		 *     memory and expect the caller to free it using free().
		 */
#		if defined(_WIN32) && defined(_MSC_VER) && _MSC_VER < 1800
			typedef unsigned __int8 uint8_t;
			typedef unsigned __int32 uint32_t;
			typedef unsigned __int64 uint64_t;
#		else
			/* Use the standard inttypes.h. */
#			ifdef __cplusplus
				/*
				 * C99 sections 7.18.2 and 7.18.4 specify
				 * that C++ implementations define the limit
				 * and constant macros only if specifically
				 * requested. Note that if you want the
				 * format macros (PRIu64 etc.) too, you need
				 * to define __STDC_FORMAT_MACROS before
				 * including lzma.h, since re-including
				 * inttypes.h with __STDC_FORMAT_MACROS
				 * defined doesn't necessarily work.
				 */
#				ifndef __STDC_LIMIT_MACROS
#					define __STDC_LIMIT_MACROS 1
#				endif
#				ifndef __STDC_CONSTANT_MACROS
#					define __STDC_CONSTANT_MACROS 1
#				endif
#			endif

#			include <inttypes.h>
#		endif

		/*
		 * Some old systems have only the typedefs in inttypes.h, and
		 * lack all the macros. For those systems, we need a few more
		 * hacks. We assume that unsigned int is 32-bit and unsigned
		 * long is either 32-bit or 64-bit. If these hacks aren't
		 * enough, the application has to setup the types manually
		 * before including lzma.h.
		 */
#		ifndef UINT32_C
#			if defined(_WIN32) && defined(_MSC_VER)
#				define UINT32_C(n) n ## UI32
#			else
#				define UINT32_C(n) n ## U
#			endif
#		endif

#		ifndef UINT64_C
#			if defined(_WIN32) && defined(_MSC_VER)
#				define UINT64_C(n) n ## UI64
#			else
				/* Get ULONG_MAX. */
#				include <limits.h>
#				if ULONG_MAX == 4294967295UL
#					define UINT64_C(n) n ## ULL
#				else
#					define UINT64_C(n) n ## UL
#				endif
#			endif
#		endif

#		ifndef UINT32_MAX
#			define UINT32_MAX (UINT32_C(4294967295))
#		endif

#		ifndef UINT64_MAX
#			define UINT64_MAX (UINT64_C(18446744073709551615))
#		endif
#	endif
#endif /* ifdef LZMA_MANUAL_HEADERS */


/******************
 * LZMA_API macro *
 ******************/

/*
 * Some systems require that the functions and function pointers are
 * declared specially in the headers. LZMA_API_IMPORT is for importing
 * symbols and LZMA_API_CALL is to specify the calling convention.
 *
 * By default it is assumed that the application will link dynamically
 * against liblzma. #define LZMA_API_STATIC in your application if you
 * want to link against static liblzma. If you don't care about portability
 * to operating systems like Windows, or at least don't care about linking
 * against static liblzma on them, don't worry about LZMA_API_STATIC. That
 * is, most developers will never need to use LZMA_API_STATIC.
 *
 * The GCC variants are a special case on Windows (Cygwin and MinGW-w64).
 * We rely on GCC doing the right thing with its auto-import feature,
 * and thus don't use __declspec(dllimport). This way developers don't
 * need to worry about LZMA_API_STATIC. Also the calling convention is
 * omitted on Cygwin but not on MinGW-w64.
 */
#ifndef LZMA_API_IMPORT
#	if !defined(LZMA_API_STATIC) && defined(_WIN32) && !defined(__GNUC__)
#		define LZMA_API_IMPORT __declspec(dllimport)
#	else
#		define LZMA_API_IMPORT
#	endif
#endif

#ifndef LZMA_API_CALL
#	if defined(_WIN32) && !defined(__CYGWIN__)
#		define LZMA_API_CALL __cdecl
#	else
#		define LZMA_API_CALL
#	endif
#endif

#ifndef LZMA_API
#	define LZMA_API(type) LZMA_API_IMPORT type LZMA_API_CALL
#endif


/***********
 * nothrow *
 ***********/

/*
 * None of the functions in liblzma may throw an exception. Even
 * the functions that use callback functions won't throw exceptions,
 * because liblzma would break if a callback function threw an exception.
 */
#ifndef lzma_nothrow
#	if defined(__cplusplus)
#		if __cplusplus >= 201103L || (defined(_MSVC_LANG) \
				&& _MSVC_LANG >= 201103L)
#			define lzma_nothrow noexcept
#		else
#			define lzma_nothrow throw()
#		endif
#	elif defined(__GNUC__) && (__GNUC__ > 3 \
			|| (__GNUC__ == 3 && __GNUC_MINOR__ >= 3))
#		define lzma_nothrow __attribute__((__nothrow__))
#	else
#		define lzma_nothrow
#	endif
#endif


/********************
 * GNU C extensions *
 ********************/

/*
 * GNU C extensions are used conditionally in the public API. It doesn't
 * break anything if these are sometimes enabled and sometimes not, only
 * affects warnings and optimizations.
 */
#if defined(__GNUC__) && __GNUC__ >= 3
#	ifndef lzma_attribute
#		define lzma_attribute(attr) __attribute__(attr)
#	endif

	/* warn_unused_result was added in GCC 3.4. */
#	ifndef lzma_attr_warn_unused_result
#		if __GNUC__ == 3 && __GNUC_MINOR__ < 4
#			define lzma_attr_warn_unused_result
#		endif
#	endif

#else
#	ifndef lzma_attribute
#		define lzma_attribute(attr)
#	endif
#endif


#ifndef lzma_attr_pure
#	define lzma_attr_pure lzma_attribute((__pure__))
#endif

#ifndef lzma_attr_const
#	define lzma_attr_const lzma_attribute((__const__))
#endif

#ifndef lzma_attr_warn_unused_result
#	define lzma_attr_warn_unused_result \
		lzma_attribute((__warn_unused_result__))
#endif


/**************
 * Subheaders *
 **************/

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Subheaders check that this is defined. It is to prevent including
 * them directly from applications.
 */
#define LZMA_H_INTERNAL 1

/* Basic features */
#include "lzma/version.h"
#include "lzma/base.h"
#include "lzma/vli.h"
#include "lzma/check.h"

/* Filters */
#include "lzma/filter.h"
#include "lzma/bcj.h"
#include "lzma/delta.h"
#include "lzma/lzma12.h"

/* Container formats */
#include "lzma/container.h"

/* Advanced features */
#include "lzma/stream_flags.h"
#include "lzma/block.h"
#include "lzma/index.h"
#include "lzma/index_hash.h"

/* Hardware information */
#include "lzma/hardware.h"

/*
 * All subheaders included. Undefine LZMA_H_INTERNAL to prevent applications
 * re-including the subheaders.
 */
#undef LZMA_H_INTERNAL

#ifdef __cplusplus
}
#endif

#endif /* ifndef LZMA_H */
