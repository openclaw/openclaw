/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/version.h
 * \brief       Version number
 * \note        Never include this file directly. Use <lzma.h> instead.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/** \brief Major version number of the liblzma release. */
#define LZMA_VERSION_MAJOR 5

/** \brief Minor version number of the liblzma release. */
#define LZMA_VERSION_MINOR 8

/** \brief Patch version number of the liblzma release. */
#define LZMA_VERSION_PATCH 3

/**
 * \brief Version stability marker
 *
 * This will always be one of three values:
 *   - LZMA_VERSION_STABILITY_ALPHA
 *   - LZMA_VERSION_STABILITY_BETA
 *   - LZMA_VERSION_STABILITY_STABLE
 */
#define LZMA_VERSION_STABILITY LZMA_VERSION_STABILITY_STABLE

/** \brief Commit version number of the liblzma release */
#ifndef LZMA_VERSION_COMMIT
#	define LZMA_VERSION_COMMIT ""
#endif


/*
 * Map symbolic stability levels to integers.
 */
#define LZMA_VERSION_STABILITY_ALPHA 0
#define LZMA_VERSION_STABILITY_BETA 1
#define LZMA_VERSION_STABILITY_STABLE 2


/**
 * \brief       Compile-time version number
 *
 * The version number is of format xyyyzzzs where
 *  - x = major
 *  - yyy = minor
 *  - zzz = revision
 *  - s indicates stability: 0 = alpha, 1 = beta, 2 = stable
 *
 * The same xyyyzzz triplet is never reused with different stability levels.
 * For example, if 5.1.0alpha has been released, there will never be 5.1.0beta
 * or 5.1.0 stable.
 *
 * \note        The version number of liblzma has nothing to with
 *              the version number of Igor Pavlov's LZMA SDK.
 */
#define LZMA_VERSION (LZMA_VERSION_MAJOR * UINT32_C(10000000) \
		+ LZMA_VERSION_MINOR * UINT32_C(10000) \
		+ LZMA_VERSION_PATCH * UINT32_C(10) \
		+ LZMA_VERSION_STABILITY)


/*
 * Macros to construct the compile-time version string
 */
#if LZMA_VERSION_STABILITY == LZMA_VERSION_STABILITY_ALPHA
#	define LZMA_VERSION_STABILITY_STRING "alpha"
#elif LZMA_VERSION_STABILITY == LZMA_VERSION_STABILITY_BETA
#	define LZMA_VERSION_STABILITY_STRING "beta"
#elif LZMA_VERSION_STABILITY == LZMA_VERSION_STABILITY_STABLE
#	define LZMA_VERSION_STABILITY_STRING ""
#else
#	error Incorrect LZMA_VERSION_STABILITY
#endif

#define LZMA_VERSION_STRING_C_(major, minor, patch, stability, commit) \
		#major "." #minor "." #patch stability commit

#define LZMA_VERSION_STRING_C(major, minor, patch, stability, commit) \
		LZMA_VERSION_STRING_C_(major, minor, patch, stability, commit)


/**
 * \brief       Compile-time version as a string
 *
 * This can be for example "4.999.5alpha", "4.999.8beta", or "5.0.0" (stable
 * versions don't have any "stable" suffix). In future, a snapshot built
 * from source code repository may include an additional suffix, for example
 * "4.999.8beta-21-g1d92". The commit ID won't be available in numeric form
 * in LZMA_VERSION macro.
 */
#define LZMA_VERSION_STRING LZMA_VERSION_STRING_C( \
		LZMA_VERSION_MAJOR, LZMA_VERSION_MINOR, \
		LZMA_VERSION_PATCH, LZMA_VERSION_STABILITY_STRING, \
		LZMA_VERSION_COMMIT)


/* #ifndef is needed for use with windres (MinGW-w64 or Cygwin). */
#ifndef LZMA_H_INTERNAL_RC

/**
 * \brief       Run-time version number as an integer
 *
 * This allows an application to compare if it was built against the same,
 * older, or newer version of liblzma that is currently running.
 *
 * \return The value of LZMA_VERSION macro at the compile time of liblzma
 */
extern LZMA_API(uint32_t) lzma_version_number(void)
		lzma_nothrow lzma_attr_const;


/**
 * \brief       Run-time version as a string
 *
 * This function may be useful to display which version of liblzma an
 * application is currently using.
 *
 * \return      Run-time version of liblzma
 */
extern LZMA_API(const char *) lzma_version_string(void)
		lzma_nothrow lzma_attr_const;

#endif
