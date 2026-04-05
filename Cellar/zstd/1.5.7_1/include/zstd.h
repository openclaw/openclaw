/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_H_235446
#define ZSTD_H_235446


/* ======   Dependencies   ======*/
#include <stddef.h>   /* size_t */

#include "zstd_errors.h" /* list of errors */
#if defined(ZSTD_STATIC_LINKING_ONLY) && !defined(ZSTD_H_ZSTD_STATIC_LINKING_ONLY)
#include <limits.h>   /* INT_MAX */
#endif /* ZSTD_STATIC_LINKING_ONLY */

#if defined (__cplusplus)
extern "C" {
#endif

/* =====   ZSTDLIB_API : control library symbols visibility   ===== */
#ifndef ZSTDLIB_VISIBLE
   /* Backwards compatibility with old macro name */
#  ifdef ZSTDLIB_VISIBILITY
#    define ZSTDLIB_VISIBLE ZSTDLIB_VISIBILITY
#  elif defined(__GNUC__) && (__GNUC__ >= 4) && !defined(__MINGW32__)
#    define ZSTDLIB_VISIBLE __attribute__ ((visibility ("default")))
#  else
#    define ZSTDLIB_VISIBLE
#  endif
#endif

#ifndef ZSTDLIB_HIDDEN
#  if defined(__GNUC__) && (__GNUC__ >= 4) && !defined(__MINGW32__)
#    define ZSTDLIB_HIDDEN __attribute__ ((visibility ("hidden")))
#  else
#    define ZSTDLIB_HIDDEN
#  endif
#endif

#if defined(ZSTD_DLL_EXPORT) && (ZSTD_DLL_EXPORT==1)
#  define ZSTDLIB_API __declspec(dllexport) ZSTDLIB_VISIBLE
#elif defined(ZSTD_DLL_IMPORT) && (ZSTD_DLL_IMPORT==1)
#  define ZSTDLIB_API __declspec(dllimport) ZSTDLIB_VISIBLE /* It isn't required but allows to generate better code, saving a function pointer load from the IAT and an indirect jump.*/
#else
#  define ZSTDLIB_API ZSTDLIB_VISIBLE
#endif

/* Deprecation warnings :
 * Should these warnings be a problem, it is generally possible to disable them,
 * typically with -Wno-deprecated-declarations for gcc or _CRT_SECURE_NO_WARNINGS in Visual.
 * Otherwise, it's also possible to define ZSTD_DISABLE_DEPRECATE_WARNINGS.
 */
#ifdef ZSTD_DISABLE_DEPRECATE_WARNINGS
#  define ZSTD_DEPRECATED(message) /* disable deprecation warnings */
#else
#  if defined (__cplusplus) && (__cplusplus >= 201402) /* C++14 or greater */
#    define ZSTD_DEPRECATED(message) [[deprecated(message)]]
#  elif (defined(GNUC) && (GNUC > 4 || (GNUC == 4 && GNUC_MINOR >= 5))) || defined(__clang__) || defined(__IAR_SYSTEMS_ICC__)
#    define ZSTD_DEPRECATED(message) __attribute__((deprecated(message)))
#  elif defined(__GNUC__) && (__GNUC__ >= 3)
#    define ZSTD_DEPRECATED(message) __attribute__((deprecated))
#  elif defined(_MSC_VER)
#    define ZSTD_DEPRECATED(message) __declspec(deprecated(message))
#  else
#    pragma message("WARNING: You need to implement ZSTD_DEPRECATED for this compiler")
#    define ZSTD_DEPRECATED(message)
#  endif
#endif /* ZSTD_DISABLE_DEPRECATE_WARNINGS */


/*******************************************************************************
  Introduction

  zstd, short for Zstandard, is a fast lossless compression algorithm, targeting
  real-time compression scenarios at zlib-level and better compression ratios.
  The zstd compression library provides in-memory compression and decompression
  functions.

  The library supports regular compression levels from 1 up to ZSTD_maxCLevel(),
  which is currently 22. Levels >= 20, labeled `--ultra`, should be used with
  caution, as they require more memory. The library also offers negative
  compression levels, which extend the range of speed vs. ratio preferences.
  The lower the level, the faster the speed (at the cost of compression).

  Compression can be done in:
    - a single step (described as Simple API)
    - a single step, reusing a context (described as Explicit context)
    - unbounded multiple steps (described as Streaming compression)

  The compression ratio achievable on small data can be highly improved using
  a dictionary. Dictionary compression can be performed in:
    - a single step (described as Simple dictionary API)
    - a single step, reusing a dictionary (described as Bulk-processing
      dictionary API)

  Advanced experimental functions can be accessed using
  `#define ZSTD_STATIC_LINKING_ONLY` before including zstd.h.

  Advanced experimental APIs should never be used with a dynamically-linked
  library. They are not "stable"; their definitions or signatures may change in
  the future. Only static linking is allowed.
*******************************************************************************/

/*------   Version   ------*/
#define ZSTD_VERSION_MAJOR    1
#define ZSTD_VERSION_MINOR    5
#define ZSTD_VERSION_RELEASE  7
#define ZSTD_VERSION_NUMBER  (ZSTD_VERSION_MAJOR *100*100 + ZSTD_VERSION_MINOR *100 + ZSTD_VERSION_RELEASE)

/*! ZSTD_versionNumber() :
 *  Return runtime library version, the value is (MAJOR*100*100 + MINOR*100 + RELEASE). */
ZSTDLIB_API unsigned ZSTD_versionNumber(void);

#define ZSTD_LIB_VERSION ZSTD_VERSION_MAJOR.ZSTD_VERSION_MINOR.ZSTD_VERSION_RELEASE
#define ZSTD_QUOTE(str) #str
#define ZSTD_EXPAND_AND_QUOTE(str) ZSTD_QUOTE(str)
#define ZSTD_VERSION_STRING ZSTD_EXPAND_AND_QUOTE(ZSTD_LIB_VERSION)

/*! ZSTD_versionString() :
 *  Return runtime library version, like "1.4.5". Requires v1.3.0+. */
ZSTDLIB_API const char* ZSTD_versionString(void);

/* *************************************
 *  Default constant
 ***************************************/
#ifndef ZSTD_CLEVEL_DEFAULT
#  define ZSTD_CLEVEL_DEFAULT 3
#endif

/* *************************************
 *  Constants
 ***************************************/

/* All magic numbers are supposed read/written to/from files/memory using little-endian convention */
#define ZSTD_MAGICNUMBER            0xFD2FB528    /* valid since v0.8.0 */
#define ZSTD_MAGIC_DICTIONARY       0xEC30A437    /* valid since v0.7.0 */
#define ZSTD_MAGIC_SKIPPABLE_START  0x184D2A50    /* all 16 values, from 0x184D2A50 to 0x184D2A5F, signal the beginning of a skippable frame */
#define ZSTD_MAGIC_SKIPPABLE_MASK   0xFFFFFFF0

#define ZSTD_BLOCKSIZELOG_MAX  17
#define ZSTD_BLOCKSIZE_MAX     (1<<ZSTD_BLOCKSIZELOG_MAX)


/***************************************
*  Simple Core API
***************************************/
/*! ZSTD_compress() :
 *  Compresses `src` content as a single zstd compressed frame into already allocated `dst`.
 *  NOTE: Providing `dstCapacity >= ZSTD_compressBound(srcSize)` guarantees that zstd will have
 *        enough space to successfully compress the data.
 *  @return : compressed size written into `dst` (<= `dstCapacity),
 *            or an error code if it fails (which can be tested using ZSTD_isError()). */
ZSTDLIB_API size_t ZSTD_compress( void* dst, size_t dstCapacity,
                            const void* src, size_t srcSize,
                                  int compressionLevel);

/*! ZSTD_decompress() :
 * `compressedSize` : must be the _exact_ size of some number of compressed and/or skippable frames.
 *  Multiple compressed frames can be decompressed at once with this method.
 *  The result will be the concatenation of all decompressed frames, back to back.
 * `dstCapacity` is an upper bound of originalSize to regenerate.
 *  First frame's decompressed size can be extracted using ZSTD_getFrameContentSize().
 *  If maximum upper bound isn't known, prefer using streaming mode to decompress data.
 * @return : the number of bytes decompressed into `dst` (<= `dstCapacity`),
 *           or an errorCode if it fails (which can be tested using ZSTD_isError()). */
ZSTDLIB_API size_t ZSTD_decompress( void* dst, size_t dstCapacity,
                              const void* src, size_t compressedSize);


/*======  Decompression helper functions  ======*/

/*! ZSTD_getFrameContentSize() : requires v1.3.0+
 * `src` should point to the start of a ZSTD encoded frame.
 * `srcSize` must be at least as large as the frame header.
 *           hint : any size >= `ZSTD_frameHeaderSize_max` is large enough.
 * @return : - decompressed size of `src` frame content, if known
 *           - ZSTD_CONTENTSIZE_UNKNOWN if the size cannot be determined
 *           - ZSTD_CONTENTSIZE_ERROR if an error occurred (e.g. invalid magic number, srcSize too small)
 *  note 1 : a 0 return value means the frame is valid but "empty".
 *           When invoking this method on a skippable frame, it will return 0.
 *  note 2 : decompressed size is an optional field, it may not be present (typically in streaming mode).
 *           When `return==ZSTD_CONTENTSIZE_UNKNOWN`, data to decompress could be any size.
 *           In which case, it's necessary to use streaming mode to decompress data.
 *           Optionally, application can rely on some implicit limit,
 *           as ZSTD_decompress() only needs an upper bound of decompressed size.
 *           (For example, data could be necessarily cut into blocks <= 16 KB).
 *  note 3 : decompressed size is always present when compression is completed using single-pass functions,
 *           such as ZSTD_compress(), ZSTD_compressCCtx() ZSTD_compress_usingDict() or ZSTD_compress_usingCDict().
 *  note 4 : decompressed size can be very large (64-bits value),
 *           potentially larger than what local system can handle as a single memory segment.
 *           In which case, it's necessary to use streaming mode to decompress data.
 *  note 5 : If source is untrusted, decompressed size could be wrong or intentionally modified.
 *           Always ensure return value fits within application's authorized limits.
 *           Each application can set its own limits.
 *  note 6 : This function replaces ZSTD_getDecompressedSize() */
#define ZSTD_CONTENTSIZE_UNKNOWN (0ULL - 1)
#define ZSTD_CONTENTSIZE_ERROR   (0ULL - 2)
ZSTDLIB_API unsigned long long ZSTD_getFrameContentSize(const void *src, size_t srcSize);

/*! ZSTD_getDecompressedSize() (obsolete):
 *  This function is now obsolete, in favor of ZSTD_getFrameContentSize().
 *  Both functions work the same way, but ZSTD_getDecompressedSize() blends
 *  "empty", "unknown" and "error" results to the same return value (0),
 *  while ZSTD_getFrameContentSize() gives them separate return values.
 * @return : decompressed size of `src` frame content _if known and not empty_, 0 otherwise. */
ZSTD_DEPRECATED("Replaced by ZSTD_getFrameContentSize")
ZSTDLIB_API unsigned long long ZSTD_getDecompressedSize(const void* src, size_t srcSize);

/*! ZSTD_findFrameCompressedSize() : Requires v1.4.0+
 * `src` should point to the start of a ZSTD frame or skippable frame.
 * `srcSize` must be >= first frame size
 * @return : the compressed size of the first frame starting at `src`,
 *           suitable to pass as `srcSize` to `ZSTD_decompress` or similar,
 *           or an error code if input is invalid
 *  Note 1: this method is called _find*() because it's not enough to read the header,
 *          it may have to scan through the frame's content, to reach its end.
 *  Note 2: this method also works with Skippable Frames. In which case,
 *          it returns the size of the complete skippable frame,
 *          which is always equal to its content size + 8 bytes for headers. */
ZSTDLIB_API size_t ZSTD_findFrameCompressedSize(const void* src, size_t srcSize);


/*======  Compression helper functions  ======*/

/*! ZSTD_compressBound() :
 * maximum compressed size in worst case single-pass scenario.
 * When invoking `ZSTD_compress()`, or any other one-pass compression function,
 * it's recommended to provide @dstCapacity >= ZSTD_compressBound(srcSize)
 * as it eliminates one potential failure scenario,
 * aka not enough room in dst buffer to write the compressed frame.
 * Note : ZSTD_compressBound() itself can fail, if @srcSize >= ZSTD_MAX_INPUT_SIZE .
 *        In which case, ZSTD_compressBound() will return an error code
 *        which can be tested using ZSTD_isError().
 *
 * ZSTD_COMPRESSBOUND() :
 * same as ZSTD_compressBound(), but as a macro.
 * It can be used to produce constants, which can be useful for static allocation,
 * for example to size a static array on stack.
 * Will produce constant value 0 if srcSize is too large.
 */
#define ZSTD_MAX_INPUT_SIZE ((sizeof(size_t)==8) ? 0xFF00FF00FF00FF00ULL : 0xFF00FF00U)
#define ZSTD_COMPRESSBOUND(srcSize)   (((size_t)(srcSize) >= ZSTD_MAX_INPUT_SIZE) ? 0 : (srcSize) + ((srcSize)>>8) + (((srcSize) < (128<<10)) ? (((128<<10) - (srcSize)) >> 11) /* margin, from 64 to 0 */ : 0))  /* this formula ensures that bound(A) + bound(B) <= bound(A+B) as long as A and B >= 128 KB */
ZSTDLIB_API size_t ZSTD_compressBound(size_t srcSize); /*!< maximum compressed size in worst case single-pass scenario */


/*======  Error helper functions  ======*/
/* ZSTD_isError() :
 * Most ZSTD_* functions returning a size_t value can be tested for error,
 * using ZSTD_isError().
 * @return 1 if error, 0 otherwise
 */
ZSTDLIB_API unsigned     ZSTD_isError(size_t result);      /*!< tells if a `size_t` function result is an error code */
ZSTDLIB_API ZSTD_ErrorCode ZSTD_getErrorCode(size_t functionResult); /* convert a result into an error code, which can be compared to error enum list */
ZSTDLIB_API const char*  ZSTD_getErrorName(size_t result); /*!< provides readable string from a function result */
ZSTDLIB_API int          ZSTD_minCLevel(void);             /*!< minimum negative compression level allowed, requires v1.4.0+ */
ZSTDLIB_API int          ZSTD_maxCLevel(void);             /*!< maximum compression level available */
ZSTDLIB_API int          ZSTD_defaultCLevel(void);         /*!< default compression level, specified by ZSTD_CLEVEL_DEFAULT, requires v1.5.0+ */


/***************************************
*  Explicit context
***************************************/
/*= Compression context
 *  When compressing many times,
 *  it is recommended to allocate a compression context just once,
 *  and reuse it for each successive compression operation.
 *  This will make the workload easier for system's memory.
 *  Note : re-using context is just a speed / resource optimization.
 *         It doesn't change the compression ratio, which remains identical.
 *  Note 2: For parallel execution in multi-threaded environments,
 *         use one different context per thread .
 */
typedef struct ZSTD_CCtx_s ZSTD_CCtx;
ZSTDLIB_API ZSTD_CCtx* ZSTD_createCCtx(void);
ZSTDLIB_API size_t     ZSTD_freeCCtx(ZSTD_CCtx* cctx);  /* compatible with NULL pointer */

/*! ZSTD_compressCCtx() :
 *  Same as ZSTD_compress(), using an explicit ZSTD_CCtx.
 *  Important : in order to mirror `ZSTD_compress()` behavior,
 *  this function compresses at the requested compression level,
 *  __ignoring any other advanced parameter__ .
 *  If any advanced parameter was set using the advanced API,
 *  they will all be reset. Only @compressionLevel remains.
 */
ZSTDLIB_API size_t ZSTD_compressCCtx(ZSTD_CCtx* cctx,
                                     void* dst, size_t dstCapacity,
                               const void* src, size_t srcSize,
                                     int compressionLevel);

/*= Decompression context
 *  When decompressing many times,
 *  it is recommended to allocate a context only once,
 *  and reuse it for each successive compression operation.
 *  This will make workload friendlier for system's memory.
 *  Use one context per thread for parallel execution. */
typedef struct ZSTD_DCtx_s ZSTD_DCtx;
ZSTDLIB_API ZSTD_DCtx* ZSTD_createDCtx(void);
ZSTDLIB_API size_t     ZSTD_freeDCtx(ZSTD_DCtx* dctx);  /* accept NULL pointer */

/*! ZSTD_decompressDCtx() :
 *  Same as ZSTD_decompress(),
 *  requires an allocated ZSTD_DCtx.
 *  Compatible with sticky parameters (see below).
 */
ZSTDLIB_API size_t ZSTD_decompressDCtx(ZSTD_DCtx* dctx,
                                       void* dst, size_t dstCapacity,
                                 const void* src, size_t srcSize);


/*********************************************
*  Advanced compression API (Requires v1.4.0+)
**********************************************/

/* API design :
 *   Parameters are pushed one by one into an existing context,
 *   using ZSTD_CCtx_set*() functions.
 *   Pushed parameters are sticky : they are valid for next compressed frame, and any subsequent frame.
 *   "sticky" parameters are applicable to `ZSTD_compress2()` and `ZSTD_compressStream*()` !
 *   __They do not apply to one-shot variants such as ZSTD_compressCCtx()__ .
 *
 *   It's possible to reset all parameters to "default" using ZSTD_CCtx_reset().
 *
 *   This API supersedes all other "advanced" API entry points in the experimental section.
 *   In the future, we expect to remove API entry points from experimental which are redundant with this API.
 */


/* Compression strategies, listed from fastest to strongest */
typedef enum { ZSTD_fast=1,
               ZSTD_dfast=2,
               ZSTD_greedy=3,
               ZSTD_lazy=4,
               ZSTD_lazy2=5,
               ZSTD_btlazy2=6,
               ZSTD_btopt=7,
               ZSTD_btultra=8,
               ZSTD_btultra2=9
               /* note : new strategies _might_ be added in the future.
                         Only the order (from fast to strong) is guaranteed */
} ZSTD_strategy;

typedef enum {

    /* compression parameters
     * Note: When compressing with a ZSTD_CDict these parameters are superseded
     * by the parameters used to construct the ZSTD_CDict.
     * See ZSTD_CCtx_refCDict() for more info (superseded-by-cdict). */
    ZSTD_c_compressionLevel=100, /* Set compression parameters according to pre-defined cLevel table.
                              * Note that exact compression parameters are dynamically determined,
                              * depending on both compression level and srcSize (when known).
                              * Default level is ZSTD_CLEVEL_DEFAULT==3.
                              * Special: value 0 means default, which is controlled by ZSTD_CLEVEL_DEFAULT.
                              * Note 1 : it's possible to pass a negative compression level.
                              * Note 2 : setting a level does not automatically set all other compression parameters
                              *   to default. Setting this will however eventually dynamically impact the compression
                              *   parameters which have not been manually set. The manually set
                              *   ones will 'stick'. */
    /* Advanced compression parameters :
     * It's possible to pin down compression parameters to some specific values.
     * In which case, these values are no longer dynamically selected by the compressor */
    ZSTD_c_windowLog=101,    /* Maximum allowed back-reference distance, expressed as power of 2.
                              * This will set a memory budget for streaming decompression,
                              * with larger values requiring more memory
                              * and typically compressing more.
                              * Must be clamped between ZSTD_WINDOWLOG_MIN and ZSTD_WINDOWLOG_MAX.
                              * Special: value 0 means "use default windowLog".
                              * Note: Using a windowLog greater than ZSTD_WINDOWLOG_LIMIT_DEFAULT
                              *       requires explicitly allowing such size at streaming decompression stage. */
    ZSTD_c_hashLog=102,      /* Size of the initial probe table, as a power of 2.
                              * Resulting memory usage is (1 << (hashLog+2)).
                              * Must be clamped between ZSTD_HASHLOG_MIN and ZSTD_HASHLOG_MAX.
                              * Larger tables improve compression ratio of strategies <= dFast,
                              * and improve speed of strategies > dFast.
                              * Special: value 0 means "use default hashLog". */
    ZSTD_c_chainLog=103,     /* Size of the multi-probe search table, as a power of 2.
                              * Resulting memory usage is (1 << (chainLog+2)).
                              * Must be clamped between ZSTD_CHAINLOG_MIN and ZSTD_CHAINLOG_MAX.
                              * Larger tables result in better and slower compression.
                              * This parameter is useless for "fast" strategy.
                              * It's still useful when using "dfast" strategy,
                              * in which case it defines a secondary probe table.
                              * Special: value 0 means "use default chainLog". */
    ZSTD_c_searchLog=104,    /* Number of search attempts, as a power of 2.
                              * More attempts result in better and slower compression.
                              * This parameter is useless for "fast" and "dFast" strategies.
                              * Special: value 0 means "use default searchLog". */
    ZSTD_c_minMatch=105,     /* Minimum size of searched matches.
                              * Note that Zstandard can still find matches of smaller size,
                              * it just tweaks its search algorithm to look for this size and larger.
                              * Larger values increase compression and decompression speed, but decrease ratio.
                              * Must be clamped between ZSTD_MINMATCH_MIN and ZSTD_MINMATCH_MAX.
                              * Note that currently, for all strategies < btopt, effective minimum is 4.
                              *                    , for all strategies > fast, effective maximum is 6.
                              * Special: value 0 means "use default minMatchLength". */
    ZSTD_c_targetLength=106, /* Impact of this field depends on strategy.
                              * For strategies btopt, btultra & btultra2:
                              *     Length of Match considered "good enough" to stop search.
                              *     Larger values make compression stronger, and slower.
                              * For strategy fast:
                              *     Distance between match sampling.
                              *     Larger values make compression faster, and weaker.
                              * Special: value 0 means "use default targetLength". */
    ZSTD_c_strategy=107,     /* See ZSTD_strategy enum definition.
                              * The higher the value of selected strategy, the more complex it is,
                              * resulting in stronger and slower compression.
                              * Special: value 0 means "use default strategy". */

    ZSTD_c_targetCBlockSize=130, /* v1.5.6+
                                  * Attempts to fit compressed block size into approximately targetCBlockSize.
                                  * Bound by ZSTD_TARGETCBLOCKSIZE_MIN and ZSTD_TARGETCBLOCKSIZE_MAX.
                                  * Note that it's not a guarantee, just a convergence target (default:0).
                                  * No target when targetCBlockSize == 0.
                                  * This is helpful in low bandwidth streaming environments to improve end-to-end latency,
                                  * when a client can make use of partial documents (a prominent example being Chrome).
                                  * Note: this parameter is stable since v1.5.6.
                                  * It was present as an experimental parameter in earlier versions,
                                  * but it's not recommended using it with earlier library versions
                                  * due to massive performance regressions.
                                  */
    /* LDM mode parameters */
    ZSTD_c_enableLongDistanceMatching=160, /* Enable long distance matching.
                                     * This parameter is designed to improve compression ratio
                                     * for large inputs, by finding large matches at long distance.
                                     * It increases memory usage and window size.
                                     * Note: enabling this parameter increases default ZSTD_c_windowLog to 128 MB
                                     * except when expressly set to a different value.
                                     * Note: will be enabled by default if ZSTD_c_windowLog >= 128 MB and
                                     * compression strategy >= ZSTD_btopt (== compression level 16+) */
    ZSTD_c_ldmHashLog=161,   /* Size of the table for long distance matching, as a power of 2.
                              * Larger values increase memory usage and compression ratio,
                              * but decrease compression speed.
                              * Must be clamped between ZSTD_HASHLOG_MIN and ZSTD_HASHLOG_MAX
                              * default: windowlog - 7.
                              * Special: value 0 means "automatically determine hashlog". */
    ZSTD_c_ldmMinMatch=162,  /* Minimum match size for long distance matcher.
                              * Larger/too small values usually decrease compression ratio.
                              * Must be clamped between ZSTD_LDM_MINMATCH_MIN and ZSTD_LDM_MINMATCH_MAX.
                              * Special: value 0 means "use default value" (default: 64). */
    ZSTD_c_ldmBucketSizeLog=163, /* Log size of each bucket in the LDM hash table for collision resolution.
                              * Larger values improve collision resolution but decrease compression speed.
                              * The maximum value is ZSTD_LDM_BUCKETSIZELOG_MAX.
                              * Special: value 0 means "use default value" (default: 3). */
    ZSTD_c_ldmHashRateLog=164, /* Frequency of inserting/looking up entries into the LDM hash table.
                              * Must be clamped between 0 and (ZSTD_WINDOWLOG_MAX - ZSTD_HASHLOG_MIN).
                              * Default is MAX(0, (windowLog - ldmHashLog)), optimizing hash table usage.
                              * Larger values improve compression speed.
                              * Deviating far from default value will likely result in a compression ratio decrease.
                              * Special: value 0 means "automatically determine hashRateLog". */

    /* frame parameters */
    ZSTD_c_contentSizeFlag=200, /* Content size will be written into frame header _whenever known_ (default:1)
                              * Content size must be known at the beginning of compression.
                              * This is automatically the case when using ZSTD_compress2(),
                              * For streaming scenarios, content size must be provided with ZSTD_CCtx_setPledgedSrcSize() */
    ZSTD_c_checksumFlag=201, /* A 32-bits checksum of content is written at end of frame (default:0) */
    ZSTD_c_dictIDFlag=202,   /* When applicable, dictionary's ID is written into frame header (default:1) */

    /* multi-threading parameters */
    /* These parameters are only active if multi-threading is enabled (compiled with build macro ZSTD_MULTITHREAD).
     * Otherwise, trying to set any other value than default (0) will be a no-op and return an error.
     * In a situation where it's unknown if the linked library supports multi-threading or not,
     * setting ZSTD_c_nbWorkers to any value >= 1 and consulting the return value provides a quick way to check this property.
     */
    ZSTD_c_nbWorkers=400,    /* Select how many threads will be spawned to compress in parallel.
                              * When nbWorkers >= 1, triggers asynchronous mode when invoking ZSTD_compressStream*() :
                              * ZSTD_compressStream*() consumes input and flush output if possible, but immediately gives back control to caller,
                              * while compression is performed in parallel, within worker thread(s).
                              * (note : a strong exception to this rule is when first invocation of ZSTD_compressStream2() sets ZSTD_e_end :
                              *  in which case, ZSTD_compressStream2() delegates to ZSTD_compress2(), which is always a blocking call).
                              * More workers improve speed, but also increase memory usage.
                              * Default value is `0`, aka "single-threaded mode" : no worker is spawned,
                              * compression is performed inside Caller's thread, and all invocations are blocking */
    ZSTD_c_jobSize=401,      /* Size of a compression job. This value is enforced only when nbWorkers >= 1.
                              * Each compression job is completed in parallel, so this value can indirectly impact the nb of active threads.
                              * 0 means default, which is dynamically determined based on compression parameters.
                              * Job size must be a minimum of overlap size, or ZSTDMT_JOBSIZE_MIN (= 512 KB), whichever is largest.
                              * The minimum size is automatically and transparently enforced. */
    ZSTD_c_overlapLog=402,   /* Control the overlap size, as a fraction of window size.
                              * The overlap size is an amount of data reloaded from previous job at the beginning of a new job.
                              * It helps preserve compression ratio, while each job is compressed in parallel.
                              * This value is enforced only when nbWorkers >= 1.
                              * Larger values increase compression ratio, but decrease speed.
                              * Possible values range from 0 to 9 :
                              * - 0 means "default" : value will be determined by the library, depending on strategy
                              * - 1 means "no overlap"
                              * - 9 means "full overlap", using a full window size.
                              * Each intermediate rank increases/decreases load size by a factor 2 :
                              * 9: full window;  8: w/2;  7: w/4;  6: w/8;  5:w/16;  4: w/32;  3:w/64;  2:w/128;  1:no overlap;  0:default
                              * default value varies between 6 and 9, depending on strategy */

    /* note : additional experimental parameters are also available
     * within the experimental section of the API.
     * At the time of this writing, they include :
     * ZSTD_c_rsyncable
     * ZSTD_c_format
     * ZSTD_c_forceMaxWindow
     * ZSTD_c_forceAttachDict
     * ZSTD_c_literalCompressionMode
     * ZSTD_c_srcSizeHint
     * ZSTD_c_enableDedicatedDictSearch
     * ZSTD_c_stableInBuffer
     * ZSTD_c_stableOutBuffer
     * ZSTD_c_blockDelimiters
     * ZSTD_c_validateSequences
     * ZSTD_c_blockSplitterLevel
     * ZSTD_c_splitAfterSequences
     * ZSTD_c_useRowMatchFinder
     * ZSTD_c_prefetchCDictTables
     * ZSTD_c_enableSeqProducerFallback
     * ZSTD_c_maxBlockSize
     * Because they are not stable, it's necessary to define ZSTD_STATIC_LINKING_ONLY to access them.
     * note : never ever use experimentalParam? names directly;
     *        also, the enums values themselves are unstable and can still change.
     */
     ZSTD_c_experimentalParam1=500,
     ZSTD_c_experimentalParam2=10,
     ZSTD_c_experimentalParam3=1000,
     ZSTD_c_experimentalParam4=1001,
     ZSTD_c_experimentalParam5=1002,
     /* was ZSTD_c_experimentalParam6=1003; is now ZSTD_c_targetCBlockSize */
     ZSTD_c_experimentalParam7=1004,
     ZSTD_c_experimentalParam8=1005,
     ZSTD_c_experimentalParam9=1006,
     ZSTD_c_experimentalParam10=1007,
     ZSTD_c_experimentalParam11=1008,
     ZSTD_c_experimentalParam12=1009,
     ZSTD_c_experimentalParam13=1010,
     ZSTD_c_experimentalParam14=1011,
     ZSTD_c_experimentalParam15=1012,
     ZSTD_c_experimentalParam16=1013,
     ZSTD_c_experimentalParam17=1014,
     ZSTD_c_experimentalParam18=1015,
     ZSTD_c_experimentalParam19=1016,
     ZSTD_c_experimentalParam20=1017
} ZSTD_cParameter;

typedef struct {
    size_t error;
    int lowerBound;
    int upperBound;
} ZSTD_bounds;

/*! ZSTD_cParam_getBounds() :
 *  All parameters must belong to an interval with lower and upper bounds,
 *  otherwise they will either trigger an error or be automatically clamped.
 * @return : a structure, ZSTD_bounds, which contains
 *         - an error status field, which must be tested using ZSTD_isError()
 *         - lower and upper bounds, both inclusive
 */
ZSTDLIB_API ZSTD_bounds ZSTD_cParam_getBounds(ZSTD_cParameter cParam);

/*! ZSTD_CCtx_setParameter() :
 *  Set one compression parameter, selected by enum ZSTD_cParameter.
 *  All parameters have valid bounds. Bounds can be queried using ZSTD_cParam_getBounds().
 *  Providing a value beyond bound will either clamp it, or trigger an error (depending on parameter).
 *  Setting a parameter is generally only possible during frame initialization (before starting compression).
 *  Exception : when using multi-threading mode (nbWorkers >= 1),
 *              the following parameters can be updated _during_ compression (within same frame):
 *              => compressionLevel, hashLog, chainLog, searchLog, minMatch, targetLength and strategy.
 *              new parameters will be active for next job only (after a flush()).
 * @return : an error code (which can be tested using ZSTD_isError()).
 */
ZSTDLIB_API size_t ZSTD_CCtx_setParameter(ZSTD_CCtx* cctx, ZSTD_cParameter param, int value);

/*! ZSTD_CCtx_setPledgedSrcSize() :
 *  Total input data size to be compressed as a single frame.
 *  Value will be written in frame header, unless if explicitly forbidden using ZSTD_c_contentSizeFlag.
 *  This value will also be controlled at end of frame, and trigger an error if not respected.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Note 1 : pledgedSrcSize==0 actually means zero, aka an empty frame.
 *           In order to mean "unknown content size", pass constant ZSTD_CONTENTSIZE_UNKNOWN.
 *           ZSTD_CONTENTSIZE_UNKNOWN is default value for any new frame.
 *  Note 2 : pledgedSrcSize is only valid once, for the next frame.
 *           It's discarded at the end of the frame, and replaced by ZSTD_CONTENTSIZE_UNKNOWN.
 *  Note 3 : Whenever all input data is provided and consumed in a single round,
 *           for example with ZSTD_compress2(),
 *           or invoking immediately ZSTD_compressStream2(,,,ZSTD_e_end),
 *           this value is automatically overridden by srcSize instead.
 */
ZSTDLIB_API size_t ZSTD_CCtx_setPledgedSrcSize(ZSTD_CCtx* cctx, unsigned long long pledgedSrcSize);

typedef enum {
    ZSTD_reset_session_only = 1,
    ZSTD_reset_parameters = 2,
    ZSTD_reset_session_and_parameters = 3
} ZSTD_ResetDirective;

/*! ZSTD_CCtx_reset() :
 *  There are 2 different things that can be reset, independently or jointly :
 *  - The session : will stop compressing current frame, and make CCtx ready to start a new one.
 *                  Useful after an error, or to interrupt any ongoing compression.
 *                  Any internal data not yet flushed is cancelled.
 *                  Compression parameters and dictionary remain unchanged.
 *                  They will be used to compress next frame.
 *                  Resetting session never fails.
 *  - The parameters : changes all parameters back to "default".
 *                  This also removes any reference to any dictionary or external sequence producer.
 *                  Parameters can only be changed between 2 sessions (i.e. no compression is currently ongoing)
 *                  otherwise the reset fails, and function returns an error value (which can be tested using ZSTD_isError())
 *  - Both : similar to resetting the session, followed by resetting parameters.
 */
ZSTDLIB_API size_t ZSTD_CCtx_reset(ZSTD_CCtx* cctx, ZSTD_ResetDirective reset);

/*! ZSTD_compress2() :
 *  Behave the same as ZSTD_compressCCtx(), but compression parameters are set using the advanced API.
 *  (note that this entry point doesn't even expose a compression level parameter).
 *  ZSTD_compress2() always starts a new frame.
 *  Should cctx hold data from a previously unfinished frame, everything about it is forgotten.
 *  - Compression parameters are pushed into CCtx before starting compression, using ZSTD_CCtx_set*()
 *  - The function is always blocking, returns when compression is completed.
 *  NOTE: Providing `dstCapacity >= ZSTD_compressBound(srcSize)` guarantees that zstd will have
 *        enough space to successfully compress the data, though it is possible it fails for other reasons.
 * @return : compressed size written into `dst` (<= `dstCapacity),
 *           or an error code if it fails (which can be tested using ZSTD_isError()).
 */
ZSTDLIB_API size_t ZSTD_compress2( ZSTD_CCtx* cctx,
                                   void* dst, size_t dstCapacity,
                             const void* src, size_t srcSize);


/***********************************************
*  Advanced decompression API (Requires v1.4.0+)
************************************************/

/* The advanced API pushes parameters one by one into an existing DCtx context.
 * Parameters are sticky, and remain valid for all following frames
 * using the same DCtx context.
 * It's possible to reset parameters to default values using ZSTD_DCtx_reset().
 * Note : This API is compatible with existing ZSTD_decompressDCtx() and ZSTD_decompressStream().
 *        Therefore, no new decompression function is necessary.
 */

typedef enum {

    ZSTD_d_windowLogMax=100, /* Select a size limit (in power of 2) beyond which
                              * the streaming API will refuse to allocate memory buffer
                              * in order to protect the host from unreasonable memory requirements.
                              * This parameter is only useful in streaming mode, since no internal buffer is allocated in single-pass mode.
                              * By default, a decompression context accepts window sizes <= (1 << ZSTD_WINDOWLOG_LIMIT_DEFAULT).
                              * Special: value 0 means "use default maximum windowLog". */

    /* note : additional experimental parameters are also available
     * within the experimental section of the API.
     * At the time of this writing, they include :
     * ZSTD_d_format
     * ZSTD_d_stableOutBuffer
     * ZSTD_d_forceIgnoreChecksum
     * ZSTD_d_refMultipleDDicts
     * ZSTD_d_disableHuffmanAssembly
     * ZSTD_d_maxBlockSize
     * Because they are not stable, it's necessary to define ZSTD_STATIC_LINKING_ONLY to access them.
     * note : never ever use experimentalParam? names directly
     */
     ZSTD_d_experimentalParam1=1000,
     ZSTD_d_experimentalParam2=1001,
     ZSTD_d_experimentalParam3=1002,
     ZSTD_d_experimentalParam4=1003,
     ZSTD_d_experimentalParam5=1004,
     ZSTD_d_experimentalParam6=1005

} ZSTD_dParameter;

/*! ZSTD_dParam_getBounds() :
 *  All parameters must belong to an interval with lower and upper bounds,
 *  otherwise they will either trigger an error or be automatically clamped.
 * @return : a structure, ZSTD_bounds, which contains
 *         - an error status field, which must be tested using ZSTD_isError()
 *         - both lower and upper bounds, inclusive
 */
ZSTDLIB_API ZSTD_bounds ZSTD_dParam_getBounds(ZSTD_dParameter dParam);

/*! ZSTD_DCtx_setParameter() :
 *  Set one compression parameter, selected by enum ZSTD_dParameter.
 *  All parameters have valid bounds. Bounds can be queried using ZSTD_dParam_getBounds().
 *  Providing a value beyond bound will either clamp it, or trigger an error (depending on parameter).
 *  Setting a parameter is only possible during frame initialization (before starting decompression).
 * @return : 0, or an error code (which can be tested using ZSTD_isError()).
 */
ZSTDLIB_API size_t ZSTD_DCtx_setParameter(ZSTD_DCtx* dctx, ZSTD_dParameter param, int value);

/*! ZSTD_DCtx_reset() :
 *  Return a DCtx to clean state.
 *  Session and parameters can be reset jointly or separately.
 *  Parameters can only be reset when no active frame is being decompressed.
 * @return : 0, or an error code, which can be tested with ZSTD_isError()
 */
ZSTDLIB_API size_t ZSTD_DCtx_reset(ZSTD_DCtx* dctx, ZSTD_ResetDirective reset);


/****************************
*  Streaming
****************************/

typedef struct ZSTD_inBuffer_s {
  const void* src;    /**< start of input buffer */
  size_t size;        /**< size of input buffer */
  size_t pos;         /**< position where reading stopped. Will be updated. Necessarily 0 <= pos <= size */
} ZSTD_inBuffer;

typedef struct ZSTD_outBuffer_s {
  void*  dst;         /**< start of output buffer */
  size_t size;        /**< size of output buffer */
  size_t pos;         /**< position where writing stopped. Will be updated. Necessarily 0 <= pos <= size */
} ZSTD_outBuffer;



/*-***********************************************************************
*  Streaming compression - HowTo
*
*  A ZSTD_CStream object is required to track streaming operation.
*  Use ZSTD_createCStream() and ZSTD_freeCStream() to create/release resources.
*  ZSTD_CStream objects can be reused multiple times on consecutive compression operations.
*  It is recommended to reuse ZSTD_CStream since it will play nicer with system's memory, by re-using already allocated memory.
*
*  For parallel execution, use one separate ZSTD_CStream per thread.
*
*  note : since v1.3.0, ZSTD_CStream and ZSTD_CCtx are the same thing.
*
*  Parameters are sticky : when starting a new compression on the same context,
*  it will reuse the same sticky parameters as previous compression session.
*  When in doubt, it's recommended to fully initialize the context before usage.
*  Use ZSTD_CCtx_reset() to reset the context and ZSTD_CCtx_setParameter(),
*  ZSTD_CCtx_setPledgedSrcSize(), or ZSTD_CCtx_loadDictionary() and friends to
*  set more specific parameters, the pledged source size, or load a dictionary.
*
*  Use ZSTD_compressStream2() with ZSTD_e_continue as many times as necessary to
*  consume input stream. The function will automatically update both `pos`
*  fields within `input` and `output`.
*  Note that the function may not consume the entire input, for example, because
*  the output buffer is already full, in which case `input.pos < input.size`.
*  The caller must check if input has been entirely consumed.
*  If not, the caller must make some room to receive more compressed data,
*  and then present again remaining input data.
*  note: ZSTD_e_continue is guaranteed to make some forward progress when called,
*        but doesn't guarantee maximal forward progress. This is especially relevant
*        when compressing with multiple threads. The call won't block if it can
*        consume some input, but if it can't it will wait for some, but not all,
*        output to be flushed.
* @return : provides a minimum amount of data remaining to be flushed from internal buffers
*           or an error code, which can be tested using ZSTD_isError().
*
*  At any moment, it's possible to flush whatever data might remain stuck within internal buffer,
*  using ZSTD_compressStream2() with ZSTD_e_flush. `output->pos` will be updated.
*  Note that, if `output->size` is too small, a single invocation with ZSTD_e_flush might not be enough (return code > 0).
*  In which case, make some room to receive more compressed data, and call again ZSTD_compressStream2() with ZSTD_e_flush.
*  You must continue calling ZSTD_compressStream2() with ZSTD_e_flush until it returns 0, at which point you can change the
*  operation.
*  note: ZSTD_e_flush will flush as much output as possible, meaning when compressing with multiple threads, it will
*        block until the flush is complete or the output buffer is full.
*  @return : 0 if internal buffers are entirely flushed,
*            >0 if some data still present within internal buffer (the value is minimal estimation of remaining size),
*            or an error code, which can be tested using ZSTD_isError().
*
*  Calling ZSTD_compressStream2() with ZSTD_e_end instructs to finish a frame.
*  It will perform a flush and write frame epilogue.
*  The epilogue is required for decoders to consider a frame completed.
*  flush operation is the same, and follows same rules as calling ZSTD_compressStream2() with ZSTD_e_flush.
*  You must continue calling ZSTD_compressStream2() with ZSTD_e_end until it returns 0, at which point you are free to
*  start a new frame.
*  note: ZSTD_e_end will flush as much output as possible, meaning when compressing with multiple threads, it will
*        block until the flush is complete or the output buffer is full.
*  @return : 0 if frame fully completed and fully flushed,
*            >0 if some data still present within internal buffer (the value is minimal estimation of remaining size),
*            or an error code, which can be tested using ZSTD_isError().
*
* *******************************************************************/

typedef ZSTD_CCtx ZSTD_CStream;  /**< CCtx and CStream are now effectively same object (>= v1.3.0) */
                                 /* Continue to distinguish them for compatibility with older versions <= v1.2.0 */
/*===== ZSTD_CStream management functions =====*/
ZSTDLIB_API ZSTD_CStream* ZSTD_createCStream(void);
ZSTDLIB_API size_t ZSTD_freeCStream(ZSTD_CStream* zcs);  /* accept NULL pointer */

/*===== Streaming compression functions =====*/
typedef enum {
    ZSTD_e_continue=0, /* collect more data, encoder decides when to output compressed result, for optimal compression ratio */
    ZSTD_e_flush=1,    /* flush any data provided so far,
                        * it creates (at least) one new block, that can be decoded immediately on reception;
                        * frame will continue: any future data can still reference previously compressed data, improving compression.
                        * note : multithreaded compression will block to flush as much output as possible. */
    ZSTD_e_end=2       /* flush any remaining data _and_ close current frame.
                        * note that frame is only closed after compressed data is fully flushed (return value == 0).
                        * After that point, any additional data starts a new frame.
                        * note : each frame is independent (does not reference any content from previous frame).
                        : note : multithreaded compression will block to flush as much output as possible. */
} ZSTD_EndDirective;

/*! ZSTD_compressStream2() : Requires v1.4.0+
 *  Behaves about the same as ZSTD_compressStream, with additional control on end directive.
 *  - Compression parameters are pushed into CCtx before starting compression, using ZSTD_CCtx_set*()
 *  - Compression parameters cannot be changed once compression is started (save a list of exceptions in multi-threading mode)
 *  - output->pos must be <= dstCapacity, input->pos must be <= srcSize
 *  - output->pos and input->pos will be updated. They are guaranteed to remain below their respective limit.
 *  - endOp must be a valid directive
 *  - When nbWorkers==0 (default), function is blocking : it completes its job before returning to caller.
 *  - When nbWorkers>=1, function is non-blocking : it copies a portion of input, distributes jobs to internal worker threads, flush to output whatever is available,
 *                                                  and then immediately returns, just indicating that there is some data remaining to be flushed.
 *                                                  The function nonetheless guarantees forward progress : it will return only after it reads or write at least 1+ byte.
 *  - Exception : if the first call requests a ZSTD_e_end directive and provides enough dstCapacity, the function delegates to ZSTD_compress2() which is always blocking.
 *  - @return provides a minimum amount of data remaining to be flushed from internal buffers
 *            or an error code, which can be tested using ZSTD_isError().
 *            if @return != 0, flush is not fully completed, there is still some data left within internal buffers.
 *            This is useful for ZSTD_e_flush, since in this case more flushes are necessary to empty all buffers.
 *            For ZSTD_e_end, @return == 0 when internal buffers are fully flushed and frame is completed.
 *  - after a ZSTD_e_end directive, if internal buffer is not fully flushed (@return != 0),
 *            only ZSTD_e_end or ZSTD_e_flush operations are allowed.
 *            Before starting a new compression job, or changing compression parameters,
 *            it is required to fully flush internal buffers.
 *  - note: if an operation ends with an error, it may leave @cctx in an undefined state.
 *          Therefore, it's UB to invoke ZSTD_compressStream2() of ZSTD_compressStream() on such a state.
 *          In order to be re-employed after an error, a state must be reset,
 *          which can be done explicitly (ZSTD_CCtx_reset()),
 *          or is sometimes implied by methods starting a new compression job (ZSTD_initCStream(), ZSTD_compressCCtx())
 */
ZSTDLIB_API size_t ZSTD_compressStream2( ZSTD_CCtx* cctx,
                                         ZSTD_outBuffer* output,
                                         ZSTD_inBuffer* input,
                                         ZSTD_EndDirective endOp);


/* These buffer sizes are softly recommended.
 * They are not required : ZSTD_compressStream*() happily accepts any buffer size, for both input and output.
 * Respecting the recommended size just makes it a bit easier for ZSTD_compressStream*(),
 * reducing the amount of memory shuffling and buffering, resulting in minor performance savings.
 *
 * However, note that these recommendations are from the perspective of a C caller program.
 * If the streaming interface is invoked from some other language,
 * especially managed ones such as Java or Go, through a foreign function interface such as jni or cgo,
 * a major performance rule is to reduce crossing such interface to an absolute minimum.
 * It's not rare that performance ends being spent more into the interface, rather than compression itself.
 * In which cases, prefer using large buffers, as large as practical,
 * for both input and output, to reduce the nb of roundtrips.
 */
ZSTDLIB_API size_t ZSTD_CStreamInSize(void);    /**< recommended size for input buffer */
ZSTDLIB_API size_t ZSTD_CStreamOutSize(void);   /**< recommended size for output buffer. Guarantee to successfully flush at least one complete compressed block. */


/* *****************************************************************************
 * This following is a legacy streaming API, available since v1.0+ .
 * It can be replaced by ZSTD_CCtx_reset() and ZSTD_compressStream2().
 * It is redundant, but remains fully supported.
 ******************************************************************************/

/*!
 * Equivalent to:
 *
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_refCDict(zcs, NULL); // clear the dictionary (if any)
 *     ZSTD_CCtx_setParameter(zcs, ZSTD_c_compressionLevel, compressionLevel);
 *
 * Note that ZSTD_initCStream() clears any previously set dictionary. Use the new API
 * to compress with a dictionary.
 */
ZSTDLIB_API size_t ZSTD_initCStream(ZSTD_CStream* zcs, int compressionLevel);
/*!
 * Alternative for ZSTD_compressStream2(zcs, output, input, ZSTD_e_continue).
 * NOTE: The return value is different. ZSTD_compressStream() returns a hint for
 * the next read size (if non-zero and not an error). ZSTD_compressStream2()
 * returns the minimum nb of bytes left to flush (if non-zero and not an error).
 */
ZSTDLIB_API size_t ZSTD_compressStream(ZSTD_CStream* zcs, ZSTD_outBuffer* output, ZSTD_inBuffer* input);
/*! Equivalent to ZSTD_compressStream2(zcs, output, &emptyInput, ZSTD_e_flush). */
ZSTDLIB_API size_t ZSTD_flushStream(ZSTD_CStream* zcs, ZSTD_outBuffer* output);
/*! Equivalent to ZSTD_compressStream2(zcs, output, &emptyInput, ZSTD_e_end). */
ZSTDLIB_API size_t ZSTD_endStream(ZSTD_CStream* zcs, ZSTD_outBuffer* output);


/*-***************************************************************************
*  Streaming decompression - HowTo
*
*  A ZSTD_DStream object is required to track streaming operations.
*  Use ZSTD_createDStream() and ZSTD_freeDStream() to create/release resources.
*  ZSTD_DStream objects can be re-employed multiple times.
*
*  Use ZSTD_initDStream() to start a new decompression operation.
* @return : recommended first input size
*  Alternatively, use advanced API to set specific properties.
*
*  Use ZSTD_decompressStream() repetitively to consume your input.
*  The function will update both `pos` fields.
*  If `input.pos < input.size`, some input has not been consumed.
*  It's up to the caller to present again remaining data.
*
*  The function tries to flush all data decoded immediately, respecting output buffer size.
*  If `output.pos < output.size`, decoder has flushed everything it could.
*
*  However, when `output.pos == output.size`, it's more difficult to know.
*  If @return > 0, the frame is not complete, meaning
*  either there is still some data left to flush within internal buffers,
*  or there is more input to read to complete the frame (or both).
*  In which case, call ZSTD_decompressStream() again to flush whatever remains in the buffer.
*  Note : with no additional input provided, amount of data flushed is necessarily <= ZSTD_BLOCKSIZE_MAX.
* @return : 0 when a frame is completely decoded and fully flushed,
*        or an error code, which can be tested using ZSTD_isError(),
*        or any other value > 0, which means there is still some decoding or flushing to do to complete current frame :
*                                the return value is a suggested next input size (just a hint for better latency)
*                                that will never request more than the remaining content of the compressed frame.
* *******************************************************************************/

typedef ZSTD_DCtx ZSTD_DStream;  /**< DCtx and DStream are now effectively same object (>= v1.3.0) */
                                 /* For compatibility with versions <= v1.2.0, prefer differentiating them. */
/*===== ZSTD_DStream management functions =====*/
ZSTDLIB_API ZSTD_DStream* ZSTD_createDStream(void);
ZSTDLIB_API size_t ZSTD_freeDStream(ZSTD_DStream* zds);  /* accept NULL pointer */

/*===== Streaming decompression functions =====*/

/*! ZSTD_initDStream() :
 * Initialize/reset DStream state for new decompression operation.
 * Call before new decompression operation using same DStream.
 *
 * Note : This function is redundant with the advanced API and equivalent to:
 *     ZSTD_DCtx_reset(zds, ZSTD_reset_session_only);
 *     ZSTD_DCtx_refDDict(zds, NULL);
 */
ZSTDLIB_API size_t ZSTD_initDStream(ZSTD_DStream* zds);

/*! ZSTD_decompressStream() :
 * Streaming decompression function.
 * Call repetitively to consume full input updating it as necessary.
 * Function will update both input and output `pos` fields exposing current state via these fields:
 * - `input.pos < input.size`, some input remaining and caller should provide remaining input
 *   on the next call.
 * - `output.pos < output.size`, decoder flushed internal output buffer.
 * - `output.pos == output.size`, unflushed data potentially present in the internal buffers,
 *   check ZSTD_decompressStream() @return value,
 *   if > 0, invoke it again to flush remaining data to output.
 * Note : with no additional input, amount of data flushed <= ZSTD_BLOCKSIZE_MAX.
 *
 * @return : 0 when a frame is completely decoded and fully flushed,
 *           or an error code, which can be tested using ZSTD_isError(),
 *           or any other value > 0, which means there is some decoding or flushing to do to complete current frame.
 *
 * Note: when an operation returns with an error code, the @zds state may be left in undefined state.
 *       It's UB to invoke `ZSTD_decompressStream()` on such a state.
 *       In order to re-use such a state, it must be first reset,
 *       which can be done explicitly (`ZSTD_DCtx_reset()`),
 *       or is implied for operations starting some new decompression job (`ZSTD_initDStream`, `ZSTD_decompressDCtx()`, `ZSTD_decompress_usingDict()`)
 */
ZSTDLIB_API size_t ZSTD_decompressStream(ZSTD_DStream* zds, ZSTD_outBuffer* output, ZSTD_inBuffer* input);

ZSTDLIB_API size_t ZSTD_DStreamInSize(void);    /*!< recommended size for input buffer */
ZSTDLIB_API size_t ZSTD_DStreamOutSize(void);   /*!< recommended size for output buffer. Guarantee to successfully flush at least one complete block in all circumstances. */


/**************************
*  Simple dictionary API
***************************/
/*! ZSTD_compress_usingDict() :
 *  Compression at an explicit compression level using a Dictionary.
 *  A dictionary can be any arbitrary data segment (also called a prefix),
 *  or a buffer with specified information (see zdict.h).
 *  Note : This function loads the dictionary, resulting in significant startup delay.
 *         It's intended for a dictionary used only once.
 *  Note 2 : When `dict == NULL || dictSize < 8` no dictionary is used. */
ZSTDLIB_API size_t ZSTD_compress_usingDict(ZSTD_CCtx* ctx,
                                           void* dst, size_t dstCapacity,
                                     const void* src, size_t srcSize,
                                     const void* dict,size_t dictSize,
                                           int compressionLevel);

/*! ZSTD_decompress_usingDict() :
 *  Decompression using a known Dictionary.
 *  Dictionary must be identical to the one used during compression.
 *  Note : This function loads the dictionary, resulting in significant startup delay.
 *         It's intended for a dictionary used only once.
 *  Note : When `dict == NULL || dictSize < 8` no dictionary is used. */
ZSTDLIB_API size_t ZSTD_decompress_usingDict(ZSTD_DCtx* dctx,
                                             void* dst, size_t dstCapacity,
                                       const void* src, size_t srcSize,
                                       const void* dict,size_t dictSize);


/***********************************
 *  Bulk processing dictionary API
 **********************************/
typedef struct ZSTD_CDict_s ZSTD_CDict;

/*! ZSTD_createCDict() :
 *  When compressing multiple messages or blocks using the same dictionary,
 *  it's recommended to digest the dictionary only once, since it's a costly operation.
 *  ZSTD_createCDict() will create a state from digesting a dictionary.
 *  The resulting state can be used for future compression operations with very limited startup cost.
 *  ZSTD_CDict can be created once and shared by multiple threads concurrently, since its usage is read-only.
 * @dictBuffer can be released after ZSTD_CDict creation, because its content is copied within CDict.
 *  Note 1 : Consider experimental function `ZSTD_createCDict_byReference()` if you prefer to not duplicate @dictBuffer content.
 *  Note 2 : A ZSTD_CDict can be created from an empty @dictBuffer,
 *      in which case the only thing that it transports is the @compressionLevel.
 *      This can be useful in a pipeline featuring ZSTD_compress_usingCDict() exclusively,
 *      expecting a ZSTD_CDict parameter with any data, including those without a known dictionary. */
ZSTDLIB_API ZSTD_CDict* ZSTD_createCDict(const void* dictBuffer, size_t dictSize,
                                         int compressionLevel);

/*! ZSTD_freeCDict() :
 *  Function frees memory allocated by ZSTD_createCDict().
 *  If a NULL pointer is passed, no operation is performed. */
ZSTDLIB_API size_t      ZSTD_freeCDict(ZSTD_CDict* CDict);

/*! ZSTD_compress_usingCDict() :
 *  Compression using a digested Dictionary.
 *  Recommended when same dictionary is used multiple times.
 *  Note : compression level is _decided at dictionary creation time_,
 *     and frame parameters are hardcoded (dictID=yes, contentSize=yes, checksum=no) */
ZSTDLIB_API size_t ZSTD_compress_usingCDict(ZSTD_CCtx* cctx,
                                            void* dst, size_t dstCapacity,
                                      const void* src, size_t srcSize,
                                      const ZSTD_CDict* cdict);


typedef struct ZSTD_DDict_s ZSTD_DDict;

/*! ZSTD_createDDict() :
 *  Create a digested dictionary, ready to start decompression operation without startup delay.
 *  dictBuffer can be released after DDict creation, as its content is copied inside DDict. */
ZSTDLIB_API ZSTD_DDict* ZSTD_createDDict(const void* dictBuffer, size_t dictSize);

/*! ZSTD_freeDDict() :
 *  Function frees memory allocated with ZSTD_createDDict()
 *  If a NULL pointer is passed, no operation is performed. */
ZSTDLIB_API size_t      ZSTD_freeDDict(ZSTD_DDict* ddict);

/*! ZSTD_decompress_usingDDict() :
 *  Decompression using a digested Dictionary.
 *  Recommended when same dictionary is used multiple times. */
ZSTDLIB_API size_t ZSTD_decompress_usingDDict(ZSTD_DCtx* dctx,
                                              void* dst, size_t dstCapacity,
                                        const void* src, size_t srcSize,
                                        const ZSTD_DDict* ddict);


/********************************
 *  Dictionary helper functions
 *******************************/

/*! ZSTD_getDictID_fromDict() : Requires v1.4.0+
 *  Provides the dictID stored within dictionary.
 *  if @return == 0, the dictionary is not conformant with Zstandard specification.
 *  It can still be loaded, but as a content-only dictionary. */
ZSTDLIB_API unsigned ZSTD_getDictID_fromDict(const void* dict, size_t dictSize);

/*! ZSTD_getDictID_fromCDict() : Requires v1.5.0+
 *  Provides the dictID of the dictionary loaded into `cdict`.
 *  If @return == 0, the dictionary is not conformant to Zstandard specification, or empty.
 *  Non-conformant dictionaries can still be loaded, but as content-only dictionaries. */
ZSTDLIB_API unsigned ZSTD_getDictID_fromCDict(const ZSTD_CDict* cdict);

/*! ZSTD_getDictID_fromDDict() : Requires v1.4.0+
 *  Provides the dictID of the dictionary loaded into `ddict`.
 *  If @return == 0, the dictionary is not conformant to Zstandard specification, or empty.
 *  Non-conformant dictionaries can still be loaded, but as content-only dictionaries. */
ZSTDLIB_API unsigned ZSTD_getDictID_fromDDict(const ZSTD_DDict* ddict);

/*! ZSTD_getDictID_fromFrame() : Requires v1.4.0+
 *  Provides the dictID required to decompressed the frame stored within `src`.
 *  If @return == 0, the dictID could not be decoded.
 *  This could for one of the following reasons :
 *  - The frame does not require a dictionary to be decoded (most common case).
 *  - The frame was built with dictID intentionally removed. Whatever dictionary is necessary is a hidden piece of information.
 *    Note : this use case also happens when using a non-conformant dictionary.
 *  - `srcSize` is too small, and as a result, the frame header could not be decoded (only possible if `srcSize < ZSTD_FRAMEHEADERSIZE_MAX`).
 *  - This is not a Zstandard frame.
 *  When identifying the exact failure cause, it's possible to use ZSTD_getFrameHeader(), which will provide a more precise error code. */
ZSTDLIB_API unsigned ZSTD_getDictID_fromFrame(const void* src, size_t srcSize);


/*******************************************************************************
 * Advanced dictionary and prefix API (Requires v1.4.0+)
 *
 * This API allows dictionaries to be used with ZSTD_compress2(),
 * ZSTD_compressStream2(), and ZSTD_decompressDCtx().
 * Dictionaries are sticky, they remain valid when same context is reused,
 * they only reset when the context is reset
 * with ZSTD_reset_parameters or ZSTD_reset_session_and_parameters.
 * In contrast, Prefixes are single-use.
 ******************************************************************************/


/*! ZSTD_CCtx_loadDictionary() : Requires v1.4.0+
 *  Create an internal CDict from `dict` buffer.
 *  Decompression will have to use same dictionary.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Special: Loading a NULL (or 0-size) dictionary invalidates previous dictionary,
 *           meaning "return to no-dictionary mode".
 *  Note 1 : Dictionary is sticky, it will be used for all future compressed frames,
 *           until parameters are reset, a new dictionary is loaded, or the dictionary
 *           is explicitly invalidated by loading a NULL dictionary.
 *  Note 2 : Loading a dictionary involves building tables.
 *           It's also a CPU consuming operation, with non-negligible impact on latency.
 *           Tables are dependent on compression parameters, and for this reason,
 *           compression parameters can no longer be changed after loading a dictionary.
 *  Note 3 :`dict` content will be copied internally.
 *           Use experimental ZSTD_CCtx_loadDictionary_byReference() to reference content instead.
 *           In such a case, dictionary buffer must outlive its users.
 *  Note 4 : Use ZSTD_CCtx_loadDictionary_advanced()
 *           to precisely select how dictionary content must be interpreted.
 *  Note 5 : This method does not benefit from LDM (long distance mode).
 *           If you want to employ LDM on some large dictionary content,
 *           prefer employing ZSTD_CCtx_refPrefix() described below.
 */
ZSTDLIB_API size_t ZSTD_CCtx_loadDictionary(ZSTD_CCtx* cctx, const void* dict, size_t dictSize);

/*! ZSTD_CCtx_refCDict() : Requires v1.4.0+
 *  Reference a prepared dictionary, to be used for all future compressed frames.
 *  Note that compression parameters are enforced from within CDict,
 *  and supersede any compression parameter previously set within CCtx.
 *  The parameters ignored are labelled as "superseded-by-cdict" in the ZSTD_cParameter enum docs.
 *  The ignored parameters will be used again if the CCtx is returned to no-dictionary mode.
 *  The dictionary will remain valid for future compressed frames using same CCtx.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Special : Referencing a NULL CDict means "return to no-dictionary mode".
 *  Note 1 : Currently, only one dictionary can be managed.
 *           Referencing a new dictionary effectively "discards" any previous one.
 *  Note 2 : CDict is just referenced, its lifetime must outlive its usage within CCtx. */
ZSTDLIB_API size_t ZSTD_CCtx_refCDict(ZSTD_CCtx* cctx, const ZSTD_CDict* cdict);

/*! ZSTD_CCtx_refPrefix() : Requires v1.4.0+
 *  Reference a prefix (single-usage dictionary) for next compressed frame.
 *  A prefix is **only used once**. Tables are discarded at end of frame (ZSTD_e_end).
 *  Decompression will need same prefix to properly regenerate data.
 *  Compressing with a prefix is similar in outcome as performing a diff and compressing it,
 *  but performs much faster, especially during decompression (compression speed is tunable with compression level).
 *  This method is compatible with LDM (long distance mode).
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Special: Adding any prefix (including NULL) invalidates any previous prefix or dictionary
 *  Note 1 : Prefix buffer is referenced. It **must** outlive compression.
 *           Its content must remain unmodified during compression.
 *  Note 2 : If the intention is to diff some large src data blob with some prior version of itself,
 *           ensure that the window size is large enough to contain the entire source.
 *           See ZSTD_c_windowLog.
 *  Note 3 : Referencing a prefix involves building tables, which are dependent on compression parameters.
 *           It's a CPU consuming operation, with non-negligible impact on latency.
 *           If there is a need to use the same prefix multiple times, consider loadDictionary instead.
 *  Note 4 : By default, the prefix is interpreted as raw content (ZSTD_dct_rawContent).
 *           Use experimental ZSTD_CCtx_refPrefix_advanced() to alter dictionary interpretation. */
ZSTDLIB_API size_t ZSTD_CCtx_refPrefix(ZSTD_CCtx* cctx,
                                 const void* prefix, size_t prefixSize);

/*! ZSTD_DCtx_loadDictionary() : Requires v1.4.0+
 *  Create an internal DDict from dict buffer, to be used to decompress all future frames.
 *  The dictionary remains valid for all future frames, until explicitly invalidated, or
 *  a new dictionary is loaded.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Special : Adding a NULL (or 0-size) dictionary invalidates any previous dictionary,
 *            meaning "return to no-dictionary mode".
 *  Note 1 : Loading a dictionary involves building tables,
 *           which has a non-negligible impact on CPU usage and latency.
 *           It's recommended to "load once, use many times", to amortize the cost
 *  Note 2 :`dict` content will be copied internally, so `dict` can be released after loading.
 *           Use ZSTD_DCtx_loadDictionary_byReference() to reference dictionary content instead.
 *  Note 3 : Use ZSTD_DCtx_loadDictionary_advanced() to take control of
 *           how dictionary content is loaded and interpreted.
 */
ZSTDLIB_API size_t ZSTD_DCtx_loadDictionary(ZSTD_DCtx* dctx, const void* dict, size_t dictSize);

/*! ZSTD_DCtx_refDDict() : Requires v1.4.0+
 *  Reference a prepared dictionary, to be used to decompress next frames.
 *  The dictionary remains active for decompression of future frames using same DCtx.
 *
 *  If called with ZSTD_d_refMultipleDDicts enabled, repeated calls of this function
 *  will store the DDict references in a table, and the DDict used for decompression
 *  will be determined at decompression time, as per the dict ID in the frame.
 *  The memory for the table is allocated on the first call to refDDict, and can be
 *  freed with ZSTD_freeDCtx().
 *
 *  If called with ZSTD_d_refMultipleDDicts disabled (the default), only one dictionary
 *  will be managed, and referencing a dictionary effectively "discards" any previous one.
 *
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Special: referencing a NULL DDict means "return to no-dictionary mode".
 *  Note 2 : DDict is just referenced, its lifetime must outlive its usage from DCtx.
 */
ZSTDLIB_API size_t ZSTD_DCtx_refDDict(ZSTD_DCtx* dctx, const ZSTD_DDict* ddict);

/*! ZSTD_DCtx_refPrefix() : Requires v1.4.0+
 *  Reference a prefix (single-usage dictionary) to decompress next frame.
 *  This is the reverse operation of ZSTD_CCtx_refPrefix(),
 *  and must use the same prefix as the one used during compression.
 *  Prefix is **only used once**. Reference is discarded at end of frame.
 *  End of frame is reached when ZSTD_decompressStream() returns 0.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Note 1 : Adding any prefix (including NULL) invalidates any previously set prefix or dictionary
 *  Note 2 : Prefix buffer is referenced. It **must** outlive decompression.
 *           Prefix buffer must remain unmodified up to the end of frame,
 *           reached when ZSTD_decompressStream() returns 0.
 *  Note 3 : By default, the prefix is treated as raw content (ZSTD_dct_rawContent).
 *           Use ZSTD_CCtx_refPrefix_advanced() to alter dictMode (Experimental section)
 *  Note 4 : Referencing a raw content prefix has almost no cpu nor memory cost.
 *           A full dictionary is more costly, as it requires building tables.
 */
ZSTDLIB_API size_t ZSTD_DCtx_refPrefix(ZSTD_DCtx* dctx,
                                 const void* prefix, size_t prefixSize);

/* ===   Memory management   === */

/*! ZSTD_sizeof_*() : Requires v1.4.0+
 *  These functions give the _current_ memory usage of selected object.
 *  Note that object memory usage can evolve (increase or decrease) over time. */
ZSTDLIB_API size_t ZSTD_sizeof_CCtx(const ZSTD_CCtx* cctx);
ZSTDLIB_API size_t ZSTD_sizeof_DCtx(const ZSTD_DCtx* dctx);
ZSTDLIB_API size_t ZSTD_sizeof_CStream(const ZSTD_CStream* zcs);
ZSTDLIB_API size_t ZSTD_sizeof_DStream(const ZSTD_DStream* zds);
ZSTDLIB_API size_t ZSTD_sizeof_CDict(const ZSTD_CDict* cdict);
ZSTDLIB_API size_t ZSTD_sizeof_DDict(const ZSTD_DDict* ddict);

#if defined (__cplusplus)
}
#endif

#endif  /* ZSTD_H_235446 */


/* **************************************************************************************
 *   ADVANCED AND EXPERIMENTAL FUNCTIONS
 ****************************************************************************************
 * The definitions in the following section are considered experimental.
 * They are provided for advanced scenarios.
 * They should never be used with a dynamic library, as prototypes may change in the future.
 * Use them only in association with static linking.
 * ***************************************************************************************/

#if defined(ZSTD_STATIC_LINKING_ONLY) && !defined(ZSTD_H_ZSTD_STATIC_LINKING_ONLY)
#define ZSTD_H_ZSTD_STATIC_LINKING_ONLY

#if defined (__cplusplus)
extern "C" {
#endif

/* This can be overridden externally to hide static symbols. */
#ifndef ZSTDLIB_STATIC_API
#  if defined(ZSTD_DLL_EXPORT) && (ZSTD_DLL_EXPORT==1)
#    define ZSTDLIB_STATIC_API __declspec(dllexport) ZSTDLIB_VISIBLE
#  elif defined(ZSTD_DLL_IMPORT) && (ZSTD_DLL_IMPORT==1)
#    define ZSTDLIB_STATIC_API __declspec(dllimport) ZSTDLIB_VISIBLE
#  else
#    define ZSTDLIB_STATIC_API ZSTDLIB_VISIBLE
#  endif
#endif

/****************************************************************************************
 *   experimental API (static linking only)
 ****************************************************************************************
 * The following symbols and constants
 * are not planned to join "stable API" status in the near future.
 * They can still change in future versions.
 * Some of them are planned to remain in the static_only section indefinitely.
 * Some of them might be removed in the future (especially when redundant with existing stable functions)
 * ***************************************************************************************/

#define ZSTD_FRAMEHEADERSIZE_PREFIX(format) ((format) == ZSTD_f_zstd1 ? 5 : 1)   /* minimum input size required to query frame header size */
#define ZSTD_FRAMEHEADERSIZE_MIN(format)    ((format) == ZSTD_f_zstd1 ? 6 : 2)
#define ZSTD_FRAMEHEADERSIZE_MAX   18   /* can be useful for static allocation */
#define ZSTD_SKIPPABLEHEADERSIZE    8

/* compression parameter bounds */
#define ZSTD_WINDOWLOG_MAX_32    30
#define ZSTD_WINDOWLOG_MAX_64    31
#define ZSTD_WINDOWLOG_MAX     ((int)(sizeof(size_t) == 4 ? ZSTD_WINDOWLOG_MAX_32 : ZSTD_WINDOWLOG_MAX_64))
#define ZSTD_WINDOWLOG_MIN       10
#define ZSTD_HASHLOG_MAX       ((ZSTD_WINDOWLOG_MAX < 30) ? ZSTD_WINDOWLOG_MAX : 30)
#define ZSTD_HASHLOG_MIN          6
#define ZSTD_CHAINLOG_MAX_32     29
#define ZSTD_CHAINLOG_MAX_64     30
#define ZSTD_CHAINLOG_MAX      ((int)(sizeof(size_t) == 4 ? ZSTD_CHAINLOG_MAX_32 : ZSTD_CHAINLOG_MAX_64))
#define ZSTD_CHAINLOG_MIN        ZSTD_HASHLOG_MIN
#define ZSTD_SEARCHLOG_MAX      (ZSTD_WINDOWLOG_MAX-1)
#define ZSTD_SEARCHLOG_MIN        1
#define ZSTD_MINMATCH_MAX         7   /* only for ZSTD_fast, other strategies are limited to 6 */
#define ZSTD_MINMATCH_MIN         3   /* only for ZSTD_btopt+, faster strategies are limited to 4 */
#define ZSTD_TARGETLENGTH_MAX    ZSTD_BLOCKSIZE_MAX
#define ZSTD_TARGETLENGTH_MIN     0   /* note : comparing this constant to an unsigned results in a tautological test */
#define ZSTD_STRATEGY_MIN        ZSTD_fast
#define ZSTD_STRATEGY_MAX        ZSTD_btultra2
#define ZSTD_BLOCKSIZE_MAX_MIN (1 << 10) /* The minimum valid max blocksize. Maximum blocksizes smaller than this make compressBound() inaccurate. */


#define ZSTD_OVERLAPLOG_MIN       0
#define ZSTD_OVERLAPLOG_MAX       9

#define ZSTD_WINDOWLOG_LIMIT_DEFAULT 27   /* by default, the streaming decoder will refuse any frame
                                           * requiring larger than (1<<ZSTD_WINDOWLOG_LIMIT_DEFAULT) window size,
                                           * to preserve host's memory from unreasonable requirements.
                                           * This limit can be overridden using ZSTD_DCtx_setParameter(,ZSTD_d_windowLogMax,).
                                           * The limit does not apply for one-pass decoders (such as ZSTD_decompress()), since no additional memory is allocated */


/* LDM parameter bounds */
#define ZSTD_LDM_HASHLOG_MIN      ZSTD_HASHLOG_MIN
#define ZSTD_LDM_HASHLOG_MAX      ZSTD_HASHLOG_MAX
#define ZSTD_LDM_MINMATCH_MIN        4
#define ZSTD_LDM_MINMATCH_MAX     4096
#define ZSTD_LDM_BUCKETSIZELOG_MIN   1
#define ZSTD_LDM_BUCKETSIZELOG_MAX   8
#define ZSTD_LDM_HASHRATELOG_MIN     0
#define ZSTD_LDM_HASHRATELOG_MAX (ZSTD_WINDOWLOG_MAX - ZSTD_HASHLOG_MIN)

/* Advanced parameter bounds */
#define ZSTD_TARGETCBLOCKSIZE_MIN   1340 /* suitable to fit into an ethernet / wifi / 4G transport frame */
#define ZSTD_TARGETCBLOCKSIZE_MAX   ZSTD_BLOCKSIZE_MAX
#define ZSTD_SRCSIZEHINT_MIN        0
#define ZSTD_SRCSIZEHINT_MAX        INT_MAX


/* ---  Advanced types  --- */

typedef struct ZSTD_CCtx_params_s ZSTD_CCtx_params;

typedef struct {
    unsigned int offset;      /* The offset of the match. (NOT the same as the offset code)
                               * If offset == 0 and matchLength == 0, this sequence represents the last
                               * literals in the block of litLength size.
                               */

    unsigned int litLength;   /* Literal length of the sequence. */
    unsigned int matchLength; /* Match length of the sequence. */

                              /* Note: Users of this API may provide a sequence with matchLength == litLength == offset == 0.
                               * In this case, we will treat the sequence as a marker for a block boundary.
                               */

    unsigned int rep;         /* Represents which repeat offset is represented by the field 'offset'.
                               * Ranges from [0, 3].
                               *
                               * Repeat offsets are essentially previous offsets from previous sequences sorted in
                               * recency order. For more detail, see doc/zstd_compression_format.md
                               *
                               * If rep == 0, then 'offset' does not contain a repeat offset.
                               * If rep > 0:
                               *  If litLength != 0:
                               *      rep == 1 --> offset == repeat_offset_1
                               *      rep == 2 --> offset == repeat_offset_2
                               *      rep == 3 --> offset == repeat_offset_3
                               *  If litLength == 0:
                               *      rep == 1 --> offset == repeat_offset_2
                               *      rep == 2 --> offset == repeat_offset_3
                               *      rep == 3 --> offset == repeat_offset_1 - 1
                               *
                               * Note: This field is optional. ZSTD_generateSequences() will calculate the value of
                               * 'rep', but repeat offsets do not necessarily need to be calculated from an external
                               * sequence provider perspective. For example, ZSTD_compressSequences() does not
                               * use this 'rep' field at all (as of now).
                               */
} ZSTD_Sequence;

typedef struct {
    unsigned windowLog;       /**< largest match distance : larger == more compression, more memory needed during decompression */
    unsigned chainLog;        /**< fully searched segment : larger == more compression, slower, more memory (useless for fast) */
    unsigned hashLog;         /**< dispatch table : larger == faster, more memory */
    unsigned searchLog;       /**< nb of searches : larger == more compression, slower */
    unsigned minMatch;        /**< match length searched : larger == faster decompression, sometimes less compression */
    unsigned targetLength;    /**< acceptable match size for optimal parser (only) : larger == more compression, slower */
    ZSTD_strategy strategy;   /**< see ZSTD_strategy definition above */
} ZSTD_compressionParameters;

typedef struct {
    int contentSizeFlag; /**< 1: content size will be in frame header (when known) */
    int checksumFlag;    /**< 1: generate a 32-bits checksum using XXH64 algorithm at end of frame, for error detection */
    int noDictIDFlag;    /**< 1: no dictID will be saved into frame header (dictID is only useful for dictionary compression) */
} ZSTD_frameParameters;

typedef struct {
    ZSTD_compressionParameters cParams;
    ZSTD_frameParameters fParams;
} ZSTD_parameters;

typedef enum {
    ZSTD_dct_auto = 0,       /* dictionary is "full" when starting with ZSTD_MAGIC_DICTIONARY, otherwise it is "rawContent" */
    ZSTD_dct_rawContent = 1, /* ensures dictionary is always loaded as rawContent, even if it starts with ZSTD_MAGIC_DICTIONARY */
    ZSTD_dct_fullDict = 2    /* refuses to load a dictionary if it does not respect Zstandard's specification, starting with ZSTD_MAGIC_DICTIONARY */
} ZSTD_dictContentType_e;

typedef enum {
    ZSTD_dlm_byCopy = 0,  /**< Copy dictionary content internally */
    ZSTD_dlm_byRef = 1    /**< Reference dictionary content -- the dictionary buffer must outlive its users. */
} ZSTD_dictLoadMethod_e;

typedef enum {
    ZSTD_f_zstd1 = 0,           /* zstd frame format, specified in zstd_compression_format.md (default) */
    ZSTD_f_zstd1_magicless = 1  /* Variant of zstd frame format, without initial 4-bytes magic number.
                                 * Useful to save 4 bytes per generated frame.
                                 * Decoder cannot recognise automatically this format, requiring this instruction. */
} ZSTD_format_e;

typedef enum {
    /* Note: this enum controls ZSTD_d_forceIgnoreChecksum */
    ZSTD_d_validateChecksum = 0,
    ZSTD_d_ignoreChecksum = 1
} ZSTD_forceIgnoreChecksum_e;

typedef enum {
    /* Note: this enum controls ZSTD_d_refMultipleDDicts */
    ZSTD_rmd_refSingleDDict = 0,
    ZSTD_rmd_refMultipleDDicts = 1
} ZSTD_refMultipleDDicts_e;

typedef enum {
    /* Note: this enum and the behavior it controls are effectively internal
     * implementation details of the compressor. They are expected to continue
     * to evolve and should be considered only in the context of extremely
     * advanced performance tuning.
     *
     * Zstd currently supports the use of a CDict in three ways:
     *
     * - The contents of the CDict can be copied into the working context. This
     *   means that the compression can search both the dictionary and input
     *   while operating on a single set of internal tables. This makes
     *   the compression faster per-byte of input. However, the initial copy of
     *   the CDict's tables incurs a fixed cost at the beginning of the
     *   compression. For small compressions (< 8 KB), that copy can dominate
     *   the cost of the compression.
     *
     * - The CDict's tables can be used in-place. In this model, compression is
     *   slower per input byte, because the compressor has to search two sets of
     *   tables. However, this model incurs no start-up cost (as long as the
     *   working context's tables can be reused). For small inputs, this can be
     *   faster than copying the CDict's tables.
     *
     * - The CDict's tables are not used at all, and instead we use the working
     *   context alone to reload the dictionary and use params based on the source
     *   size. See ZSTD_compress_insertDictionary() and ZSTD_compress_usingDict().
     *   This method is effective when the dictionary sizes are very small relative
     *   to the input size, and the input size is fairly large to begin with.
     *
     * Zstd has a simple internal heuristic that selects which strategy to use
     * at the beginning of a compression. However, if experimentation shows that
     * Zstd is making poor choices, it is possible to override that choice with
     * this enum.
     */
    ZSTD_dictDefaultAttach = 0, /* Use the default heuristic. */
    ZSTD_dictForceAttach   = 1, /* Never copy the dictionary. */
    ZSTD_dictForceCopy     = 2, /* Always copy the dictionary. */
    ZSTD_dictForceLoad     = 3  /* Always reload the dictionary */
} ZSTD_dictAttachPref_e;

typedef enum {
  ZSTD_lcm_auto = 0,          /**< Automatically determine the compression mode based on the compression level.
                               *   Negative compression levels will be uncompressed, and positive compression
                               *   levels will be compressed. */
  ZSTD_lcm_huffman = 1,       /**< Always attempt Huffman compression. Uncompressed literals will still be
                               *   emitted if Huffman compression is not profitable. */
  ZSTD_lcm_uncompressed = 2   /**< Always emit uncompressed literals. */
} ZSTD_literalCompressionMode_e;

typedef enum {
  /* Note: This enum controls features which are conditionally beneficial.
   * Zstd can take a decision on whether or not to enable the feature (ZSTD_ps_auto),
   * but setting the switch to ZSTD_ps_enable or ZSTD_ps_disable force enable/disable the feature.
   */
  ZSTD_ps_auto = 0,         /* Let the library automatically determine whether the feature shall be enabled */
  ZSTD_ps_enable = 1,       /* Force-enable the feature */
  ZSTD_ps_disable = 2       /* Do not use the feature */
} ZSTD_ParamSwitch_e;
#define ZSTD_paramSwitch_e ZSTD_ParamSwitch_e  /* old name */

/***************************************
*  Frame header and size functions
***************************************/

/*! ZSTD_findDecompressedSize() :
 *  `src` should point to the start of a series of ZSTD encoded and/or skippable frames
 *  `srcSize` must be the _exact_ size of this series
 *       (i.e. there should be a frame boundary at `src + srcSize`)
 *  @return : - decompressed size of all data in all successive frames
 *            - if the decompressed size cannot be determined: ZSTD_CONTENTSIZE_UNKNOWN
 *            - if an error occurred: ZSTD_CONTENTSIZE_ERROR
 *
 *   note 1 : decompressed size is an optional field, that may not be present, especially in streaming mode.
 *            When `return==ZSTD_CONTENTSIZE_UNKNOWN`, data to decompress could be any size.
 *            In which case, it's necessary to use streaming mode to decompress data.
 *   note 2 : decompressed size is always present when compression is done with ZSTD_compress()
 *   note 3 : decompressed size can be very large (64-bits value),
 *            potentially larger than what local system can handle as a single memory segment.
 *            In which case, it's necessary to use streaming mode to decompress data.
 *   note 4 : If source is untrusted, decompressed size could be wrong or intentionally modified.
 *            Always ensure result fits within application's authorized limits.
 *            Each application can set its own limits.
 *   note 5 : ZSTD_findDecompressedSize handles multiple frames, and so it must traverse the input to
 *            read each contained frame header.  This is fast as most of the data is skipped,
 *            however it does mean that all frame data must be present and valid. */
ZSTDLIB_STATIC_API unsigned long long ZSTD_findDecompressedSize(const void* src, size_t srcSize);

/*! ZSTD_decompressBound() :
 *  `src` should point to the start of a series of ZSTD encoded and/or skippable frames
 *  `srcSize` must be the _exact_ size of this series
 *       (i.e. there should be a frame boundary at `src + srcSize`)
 *  @return : - upper-bound for the decompressed size of all data in all successive frames
 *            - if an error occurred: ZSTD_CONTENTSIZE_ERROR
 *
 *  note 1  : an error can occur if `src` contains an invalid or incorrectly formatted frame.
 *  note 2  : the upper-bound is exact when the decompressed size field is available in every ZSTD encoded frame of `src`.
 *            in this case, `ZSTD_findDecompressedSize` and `ZSTD_decompressBound` return the same value.
 *  note 3  : when the decompressed size field isn't available, the upper-bound for that frame is calculated by:
 *              upper-bound = # blocks * min(128 KB, Window_Size)
 */
ZSTDLIB_STATIC_API unsigned long long ZSTD_decompressBound(const void* src, size_t srcSize);

/*! ZSTD_frameHeaderSize() :
 *  srcSize must be large enough, aka >= ZSTD_FRAMEHEADERSIZE_PREFIX.
 * @return : size of the Frame Header,
 *           or an error code (if srcSize is too small) */
ZSTDLIB_STATIC_API size_t ZSTD_frameHeaderSize(const void* src, size_t srcSize);

typedef enum { ZSTD_frame, ZSTD_skippableFrame } ZSTD_FrameType_e;
#define ZSTD_frameType_e ZSTD_FrameType_e /* old name */
typedef struct {
    unsigned long long frameContentSize; /* if == ZSTD_CONTENTSIZE_UNKNOWN, it means this field is not available. 0 means "empty" */
    unsigned long long windowSize;       /* can be very large, up to <= frameContentSize */
    unsigned blockSizeMax;
    ZSTD_FrameType_e frameType;          /* if == ZSTD_skippableFrame, frameContentSize is the size of skippable content */
    unsigned headerSize;
    unsigned dictID;                     /* for ZSTD_skippableFrame, contains the skippable magic variant [0-15] */
    unsigned checksumFlag;
    unsigned _reserved1;
    unsigned _reserved2;
} ZSTD_FrameHeader;
#define ZSTD_frameHeader ZSTD_FrameHeader /* old name */

/*! ZSTD_getFrameHeader() :
 *  decode Frame Header into `zfhPtr`, or requires larger `srcSize`.
 * @return : 0 => header is complete, `zfhPtr` is correctly filled,
 *          >0 => `srcSize` is too small, @return value is the wanted `srcSize` amount, `zfhPtr` is not filled,
 *           or an error code, which can be tested using ZSTD_isError() */
ZSTDLIB_STATIC_API size_t ZSTD_getFrameHeader(ZSTD_FrameHeader* zfhPtr, const void* src, size_t srcSize);
/*! ZSTD_getFrameHeader_advanced() :
 *  same as ZSTD_getFrameHeader(),
 *  with added capability to select a format (like ZSTD_f_zstd1_magicless) */
ZSTDLIB_STATIC_API size_t ZSTD_getFrameHeader_advanced(ZSTD_FrameHeader* zfhPtr, const void* src, size_t srcSize, ZSTD_format_e format);

/*! ZSTD_decompressionMargin() :
 * Zstd supports in-place decompression, where the input and output buffers overlap.
 * In this case, the output buffer must be at least (Margin + Output_Size) bytes large,
 * and the input buffer must be at the end of the output buffer.
 *
 *  _______________________ Output Buffer ________________________
 * |                                                              |
 * |                                        ____ Input Buffer ____|
 * |                                       |                      |
 * v                                       v                      v
 * |---------------------------------------|-----------|----------|
 * ^                                                   ^          ^
 * |___________________ Output_Size ___________________|_ Margin _|
 *
 * NOTE: See also ZSTD_DECOMPRESSION_MARGIN().
 * NOTE: This applies only to single-pass decompression through ZSTD_decompress() or
 * ZSTD_decompressDCtx().
 * NOTE: This function supports multi-frame input.
 *
 * @param src The compressed frame(s)
 * @param srcSize The size of the compressed frame(s)
 * @returns The decompression margin or an error that can be checked with ZSTD_isError().
 */
ZSTDLIB_STATIC_API size_t ZSTD_decompressionMargin(const void* src, size_t srcSize);

/*! ZSTD_DECOMPRESS_MARGIN() :
 * Similar to ZSTD_decompressionMargin(), but instead of computing the margin from
 * the compressed frame, compute it from the original size and the blockSizeLog.
 * See ZSTD_decompressionMargin() for details.
 *
 * WARNING: This macro does not support multi-frame input, the input must be a single
 * zstd frame. If you need that support use the function, or implement it yourself.
 *
 * @param originalSize The original uncompressed size of the data.
 * @param blockSize    The block size == MIN(windowSize, ZSTD_BLOCKSIZE_MAX).
 *                     Unless you explicitly set the windowLog smaller than
 *                     ZSTD_BLOCKSIZELOG_MAX you can just use ZSTD_BLOCKSIZE_MAX.
 */
#define ZSTD_DECOMPRESSION_MARGIN(originalSize, blockSize) ((size_t)(                                              \
        ZSTD_FRAMEHEADERSIZE_MAX                                                              /* Frame header */ + \
        4                                                                                         /* checksum */ + \
        ((originalSize) == 0 ? 0 : 3 * (((originalSize) + (blockSize) - 1) / blockSize)) /* 3 bytes per block */ + \
        (blockSize)                                                                    /* One block of margin */   \
    ))

typedef enum {
  ZSTD_sf_noBlockDelimiters = 0,         /* ZSTD_Sequence[] has no block delimiters, just sequences */
  ZSTD_sf_explicitBlockDelimiters = 1    /* ZSTD_Sequence[] contains explicit block delimiters */
} ZSTD_SequenceFormat_e;
#define ZSTD_sequenceFormat_e ZSTD_SequenceFormat_e /* old name */

/*! ZSTD_sequenceBound() :
 * `srcSize` : size of the input buffer
 *  @return : upper-bound for the number of sequences that can be generated
 *            from a buffer of srcSize bytes
 *
 *  note : returns number of sequences - to get bytes, multiply by sizeof(ZSTD_Sequence).
 */
ZSTDLIB_STATIC_API size_t ZSTD_sequenceBound(size_t srcSize);

/*! ZSTD_generateSequences() :
 * WARNING: This function is meant for debugging and informational purposes ONLY!
 * Its implementation is flawed, and it will be deleted in a future version.
 * It is not guaranteed to succeed, as there are several cases where it will give
 * up and fail. You should NOT use this function in production code.
 *
 * This function is deprecated, and will be removed in a future version.
 *
 * Generate sequences using ZSTD_compress2(), given a source buffer.
 *
 * @param zc The compression context to be used for ZSTD_compress2(). Set any
 *           compression parameters you need on this context.
 * @param outSeqs The output sequences buffer of size @p outSeqsSize
 * @param outSeqsCapacity The size of the output sequences buffer.
 *                    ZSTD_sequenceBound(srcSize) is an upper bound on the number
 *                    of sequences that can be generated.
 * @param src The source buffer to generate sequences from of size @p srcSize.
 * @param srcSize The size of the source buffer.
 *
 * Each block will end with a dummy sequence
 * with offset == 0, matchLength == 0, and litLength == length of last literals.
 * litLength may be == 0, and if so, then the sequence of (of: 0 ml: 0 ll: 0)
 * simply acts as a block delimiter.
 *
 * @returns The number of sequences generated, necessarily less than
 *          ZSTD_sequenceBound(srcSize), or an error code that can be checked
 *          with ZSTD_isError().
 */
ZSTD_DEPRECATED("For debugging only, will be replaced by ZSTD_extractSequences()")
ZSTDLIB_STATIC_API size_t
ZSTD_generateSequences(ZSTD_CCtx* zc,
                       ZSTD_Sequence* outSeqs, size_t outSeqsCapacity,
                       const void* src, size_t srcSize);

/*! ZSTD_mergeBlockDelimiters() :
 * Given an array of ZSTD_Sequence, remove all sequences that represent block delimiters/last literals
 * by merging them into the literals of the next sequence.
 *
 * As such, the final generated result has no explicit representation of block boundaries,
 * and the final last literals segment is not represented in the sequences.
 *
 * The output of this function can be fed into ZSTD_compressSequences() with CCtx
 * setting of ZSTD_c_blockDelimiters as ZSTD_sf_noBlockDelimiters
 * @return : number of sequences left after merging
 */
ZSTDLIB_STATIC_API size_t ZSTD_mergeBlockDelimiters(ZSTD_Sequence* sequences, size_t seqsSize);

/*! ZSTD_compressSequences() :
 * Compress an array of ZSTD_Sequence, associated with @src buffer, into dst.
 * @src contains the entire input (not just the literals).
 * If @srcSize > sum(sequence.length), the remaining bytes are considered all literals
 * If a dictionary is included, then the cctx should reference the dict (see: ZSTD_CCtx_refCDict(), ZSTD_CCtx_loadDictionary(), etc.).
 * The entire source is compressed into a single frame.
 *
 * The compression behavior changes based on cctx params. In particular:
 *    If ZSTD_c_blockDelimiters == ZSTD_sf_noBlockDelimiters, the array of ZSTD_Sequence is expected to contain
 *    no block delimiters (defined in ZSTD_Sequence). Block boundaries are roughly determined based on
 *    the block size derived from the cctx, and sequences may be split. This is the default setting.
 *
 *    If ZSTD_c_blockDelimiters == ZSTD_sf_explicitBlockDelimiters, the array of ZSTD_Sequence is expected to contain
 *    valid block delimiters (defined in ZSTD_Sequence). Behavior is undefined if no block delimiters are provided.
 *
 *    When ZSTD_c_blockDelimiters == ZSTD_sf_explicitBlockDelimiters, it's possible to decide generating repcodes
 *    using the advanced parameter ZSTD_c_repcodeResolution. Repcodes will improve compression ratio, though the benefit
 *    can vary greatly depending on Sequences. On the other hand, repcode resolution is an expensive operation.
 *    By default, it's disabled at low (<10) compression levels, and enabled above the threshold (>=10).
 *    ZSTD_c_repcodeResolution makes it possible to directly manage this processing in either direction.
 *
 *    If ZSTD_c_validateSequences == 0, this function blindly accepts the Sequences provided. Invalid Sequences cause undefined
 *    behavior. If ZSTD_c_validateSequences == 1, then the function will detect invalid Sequences (see doc/zstd_compression_format.md for
 *    specifics regarding offset/matchlength requirements) and then bail out and return an error.
 *
 *    In addition to the two adjustable experimental params, there are other important cctx params.
 *    - ZSTD_c_minMatch MUST be set as less than or equal to the smallest match generated by the match finder. It has a minimum value of ZSTD_MINMATCH_MIN.
 *    - ZSTD_c_compressionLevel accordingly adjusts the strength of the entropy coder, as it would in typical compression.
 *    - ZSTD_c_windowLog affects offset validation: this function will return an error at higher debug levels if a provided offset
 *      is larger than what the spec allows for a given window log and dictionary (if present). See: doc/zstd_compression_format.md
 *
 * Note: Repcodes are, as of now, always re-calculated within this function, ZSTD_Sequence.rep is effectively unused.
 * Dev Note: Once ability to ingest repcodes become available, the explicit block delims mode must respect those repcodes exactly,
 *         and cannot emit an RLE block that disagrees with the repcode history.
 * @return : final compressed size, or a ZSTD error code.
 */
ZSTDLIB_STATIC_API size_t
ZSTD_compressSequences(ZSTD_CCtx* cctx,
                       void* dst, size_t dstCapacity,
                 const ZSTD_Sequence* inSeqs, size_t inSeqsSize,
                 const void* src, size_t srcSize);


/*! ZSTD_compressSequencesAndLiterals() :
 * This is a variant of ZSTD_compressSequences() which,
 * instead of receiving (src,srcSize) as input parameter, receives (literals,litSize),
 * aka all the literals, already extracted and laid out into a single continuous buffer.
 * This can be useful if the process generating the sequences also happens to generate the buffer of literals,
 * thus skipping an extraction + caching stage.
 * It's a speed optimization, useful when the right conditions are met,
 * but it also features the following limitations:
 * - Only supports explicit delimiter mode
 * - Currently does not support Sequences validation (so input Sequences are trusted)
 * - Not compatible with frame checksum, which must be disabled
 * - If any block is incompressible, will fail and return an error
 * - @litSize must be == sum of all @.litLength fields in @inSeqs. Any discrepancy will generate an error.
 * - @litBufCapacity is the size of the underlying buffer into which literals are written, starting at address @literals.
 *   @litBufCapacity must be at least 8 bytes larger than @litSize.
 * - @decompressedSize must be correct, and correspond to the sum of all Sequences. Any discrepancy will generate an error.
 * @return : final compressed size, or a ZSTD error code.
 */
ZSTDLIB_STATIC_API size_t
ZSTD_compressSequencesAndLiterals(ZSTD_CCtx* cctx,
                                  void* dst, size_t dstCapacity,
                            const ZSTD_Sequence* inSeqs, size_t nbSequences,
                            const void* literals, size_t litSize, size_t litBufCapacity,
                            size_t decompressedSize);


/*! ZSTD_writeSkippableFrame() :
 * Generates a zstd skippable frame containing data given by src, and writes it to dst buffer.
 *
 * Skippable frames begin with a 4-byte magic number. There are 16 possible choices of magic number,
 * ranging from ZSTD_MAGIC_SKIPPABLE_START to ZSTD_MAGIC_SKIPPABLE_START+15.
 * As such, the parameter magicVariant controls the exact skippable frame magic number variant used,
 * so the magic number used will be ZSTD_MAGIC_SKIPPABLE_START + magicVariant.
 *
 * Returns an error if destination buffer is not large enough, if the source size is not representable
 * with a 4-byte unsigned int, or if the parameter magicVariant is greater than 15 (and therefore invalid).
 *
 * @return : number of bytes written or a ZSTD error.
 */
ZSTDLIB_STATIC_API size_t ZSTD_writeSkippableFrame(void* dst, size_t dstCapacity,
                                             const void* src, size_t srcSize,
                                                   unsigned magicVariant);

/*! ZSTD_readSkippableFrame() :
 * Retrieves the content of a zstd skippable frame starting at @src, and writes it to @dst buffer.
 *
 * The parameter @magicVariant will receive the magicVariant that was supplied when the frame was written,
 * i.e. magicNumber - ZSTD_MAGIC_SKIPPABLE_START.
 * This can be NULL if the caller is not interested in the magicVariant.
 *
 * Returns an error if destination buffer is not large enough, or if the frame is not skippable.
 *
 * @return : number of bytes written or a ZSTD error.
 */
ZSTDLIB_STATIC_API size_t ZSTD_readSkippableFrame(void* dst, size_t dstCapacity,
                                                  unsigned* magicVariant,
                                                  const void* src, size_t srcSize);

/*! ZSTD_isSkippableFrame() :
 *  Tells if the content of `buffer` starts with a valid Frame Identifier for a skippable frame.
 */
ZSTDLIB_STATIC_API unsigned ZSTD_isSkippableFrame(const void* buffer, size_t size);



/***************************************
*  Memory management
***************************************/

/*! ZSTD_estimate*() :
 *  These functions make it possible to estimate memory usage
 *  of a future {D,C}Ctx, before its creation.
 *  This is useful in combination with ZSTD_initStatic(),
 *  which makes it possible to employ a static buffer for ZSTD_CCtx* state.
 *
 *  ZSTD_estimateCCtxSize() will provide a memory budget large enough
 *  to compress data of any size using one-shot compression ZSTD_compressCCtx() or ZSTD_compress2()
 *  associated with any compression level up to max specified one.
 *  The estimate will assume the input may be arbitrarily large,
 *  which is the worst case.
 *
 *  Note that the size estimation is specific for one-shot compression,
 *  it is not valid for streaming (see ZSTD_estimateCStreamSize*())
 *  nor other potential ways of using a ZSTD_CCtx* state.
 *
 *  When srcSize can be bound by a known and rather "small" value,
 *  this knowledge can be used to provide a tighter budget estimation
 *  because the ZSTD_CCtx* state will need less memory for small inputs.
 *  This tighter estimation can be provided by employing more advanced functions
 *  ZSTD_estimateCCtxSize_usingCParams(), which can be used in tandem with ZSTD_getCParams(),
 *  and ZSTD_estimateCCtxSize_usingCCtxParams(), which can be used in tandem with ZSTD_CCtxParams_setParameter().
 *  Both can be used to estimate memory using custom compression parameters and arbitrary srcSize limits.
 *
 *  Note : only single-threaded compression is supported.
 *  ZSTD_estimateCCtxSize_usingCCtxParams() will return an error code if ZSTD_c_nbWorkers is >= 1.
 */
ZSTDLIB_STATIC_API size_t ZSTD_estimateCCtxSize(int maxCompressionLevel);
ZSTDLIB_STATIC_API size_t ZSTD_estimateCCtxSize_usingCParams(ZSTD_compressionParameters cParams);
ZSTDLIB_STATIC_API size_t ZSTD_estimateCCtxSize_usingCCtxParams(const ZSTD_CCtx_params* params);
ZSTDLIB_STATIC_API size_t ZSTD_estimateDCtxSize(void);

/*! ZSTD_estimateCStreamSize() :
 *  ZSTD_estimateCStreamSize() will provide a memory budget large enough for streaming compression
 *  using any compression level up to the max specified one.
 *  It will also consider src size to be arbitrarily "large", which is a worst case scenario.
 *  If srcSize is known to always be small, ZSTD_estimateCStreamSize_usingCParams() can provide a tighter estimation.
 *  ZSTD_estimateCStreamSize_usingCParams() can be used in tandem with ZSTD_getCParams() to create cParams from compressionLevel.
 *  ZSTD_estimateCStreamSize_usingCCtxParams() can be used in tandem with ZSTD_CCtxParams_setParameter(). Only single-threaded compression is supported. This function will return an error code if ZSTD_c_nbWorkers is >= 1.
 *  Note : CStream size estimation is only correct for single-threaded compression.
 *  ZSTD_estimateCStreamSize_usingCCtxParams() will return an error code if ZSTD_c_nbWorkers is >= 1.
 *  Note 2 : ZSTD_estimateCStreamSize* functions are not compatible with the Block-Level Sequence Producer API at this time.
 *  Size estimates assume that no external sequence producer is registered.
 *
 *  ZSTD_DStream memory budget depends on frame's window Size.
 *  This information can be passed manually, using ZSTD_estimateDStreamSize,
 *  or deducted from a valid frame Header, using ZSTD_estimateDStreamSize_fromFrame();
 *  Any frame requesting a window size larger than max specified one will be rejected.
 *  Note : if streaming is init with function ZSTD_init?Stream_usingDict(),
 *         an internal ?Dict will be created, which additional size is not estimated here.
 *         In this case, get total size by adding ZSTD_estimate?DictSize
 */
ZSTDLIB_STATIC_API size_t ZSTD_estimateCStreamSize(int maxCompressionLevel);
ZSTDLIB_STATIC_API size_t ZSTD_estimateCStreamSize_usingCParams(ZSTD_compressionParameters cParams);
ZSTDLIB_STATIC_API size_t ZSTD_estimateCStreamSize_usingCCtxParams(const ZSTD_CCtx_params* params);
ZSTDLIB_STATIC_API size_t ZSTD_estimateDStreamSize(size_t maxWindowSize);
ZSTDLIB_STATIC_API size_t ZSTD_estimateDStreamSize_fromFrame(const void* src, size_t srcSize);

/*! ZSTD_estimate?DictSize() :
 *  ZSTD_estimateCDictSize() will bet that src size is relatively "small", and content is copied, like ZSTD_createCDict().
 *  ZSTD_estimateCDictSize_advanced() makes it possible to control compression parameters precisely, like ZSTD_createCDict_advanced().
 *  Note : dictionaries created by reference (`ZSTD_dlm_byRef`) are logically smaller.
 */
ZSTDLIB_STATIC_API size_t ZSTD_estimateCDictSize(size_t dictSize, int compressionLevel);
ZSTDLIB_STATIC_API size_t ZSTD_estimateCDictSize_advanced(size_t dictSize, ZSTD_compressionParameters cParams, ZSTD_dictLoadMethod_e dictLoadMethod);
ZSTDLIB_STATIC_API size_t ZSTD_estimateDDictSize(size_t dictSize, ZSTD_dictLoadMethod_e dictLoadMethod);

/*! ZSTD_initStatic*() :
 *  Initialize an object using a pre-allocated fixed-size buffer.
 *  workspace: The memory area to emplace the object into.
 *             Provided pointer *must be 8-bytes aligned*.
 *             Buffer must outlive object.
 *  workspaceSize: Use ZSTD_estimate*Size() to determine
 *                 how large workspace must be to support target scenario.
 * @return : pointer to object (same address as workspace, just different type),
 *           or NULL if error (size too small, incorrect alignment, etc.)
 *  Note : zstd will never resize nor malloc() when using a static buffer.
 *         If the object requires more memory than available,
 *         zstd will just error out (typically ZSTD_error_memory_allocation).
 *  Note 2 : there is no corresponding "free" function.
 *           Since workspace is allocated externally, it must be freed externally too.
 *  Note 3 : cParams : use ZSTD_getCParams() to convert a compression level
 *           into its associated cParams.
 *  Limitation 1 : currently not compatible with internal dictionary creation, triggered by
 *                 ZSTD_CCtx_loadDictionary(), ZSTD_initCStream_usingDict() or ZSTD_initDStream_usingDict().
 *  Limitation 2 : static cctx currently not compatible with multi-threading.
 *  Limitation 3 : static dctx is incompatible with legacy support.
 */
ZSTDLIB_STATIC_API ZSTD_CCtx*    ZSTD_initStaticCCtx(void* workspace, size_t workspaceSize);
ZSTDLIB_STATIC_API ZSTD_CStream* ZSTD_initStaticCStream(void* workspace, size_t workspaceSize);    /**< same as ZSTD_initStaticCCtx() */

ZSTDLIB_STATIC_API ZSTD_DCtx*    ZSTD_initStaticDCtx(void* workspace, size_t workspaceSize);
ZSTDLIB_STATIC_API ZSTD_DStream* ZSTD_initStaticDStream(void* workspace, size_t workspaceSize);    /**< same as ZSTD_initStaticDCtx() */

ZSTDLIB_STATIC_API const ZSTD_CDict* ZSTD_initStaticCDict(
                                        void* workspace, size_t workspaceSize,
                                        const void* dict, size_t dictSize,
                                        ZSTD_dictLoadMethod_e dictLoadMethod,
                                        ZSTD_dictContentType_e dictContentType,
                                        ZSTD_compressionParameters cParams);

ZSTDLIB_STATIC_API const ZSTD_DDict* ZSTD_initStaticDDict(
                                        void* workspace, size_t workspaceSize,
                                        const void* dict, size_t dictSize,
                                        ZSTD_dictLoadMethod_e dictLoadMethod,
                                        ZSTD_dictContentType_e dictContentType);


/*! Custom memory allocation :
 *  These prototypes make it possible to pass your own allocation/free functions.
 *  ZSTD_customMem is provided at creation time, using ZSTD_create*_advanced() variants listed below.
 *  All allocation/free operations will be completed using these custom variants instead of regular <stdlib.h> ones.
 */
typedef void* (*ZSTD_allocFunction) (void* opaque, size_t size);
typedef void  (*ZSTD_freeFunction) (void* opaque, void* address);
typedef struct { ZSTD_allocFunction customAlloc; ZSTD_freeFunction customFree; void* opaque; } ZSTD_customMem;
static
#ifdef __GNUC__
__attribute__((__unused__))
#endif

#if defined(__clang__) && __clang_major__ >= 5
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wzero-as-null-pointer-constant"
#endif
ZSTD_customMem const ZSTD_defaultCMem = { NULL, NULL, NULL };  /**< this constant defers to stdlib's functions */
#if defined(__clang__) && __clang_major__ >= 5
#pragma clang diagnostic pop
#endif

ZSTDLIB_STATIC_API ZSTD_CCtx*    ZSTD_createCCtx_advanced(ZSTD_customMem customMem);
ZSTDLIB_STATIC_API ZSTD_CStream* ZSTD_createCStream_advanced(ZSTD_customMem customMem);
ZSTDLIB_STATIC_API ZSTD_DCtx*    ZSTD_createDCtx_advanced(ZSTD_customMem customMem);
ZSTDLIB_STATIC_API ZSTD_DStream* ZSTD_createDStream_advanced(ZSTD_customMem customMem);

ZSTDLIB_STATIC_API ZSTD_CDict* ZSTD_createCDict_advanced(const void* dict, size_t dictSize,
                                                  ZSTD_dictLoadMethod_e dictLoadMethod,
                                                  ZSTD_dictContentType_e dictContentType,
                                                  ZSTD_compressionParameters cParams,
                                                  ZSTD_customMem customMem);

/*! Thread pool :
 *  These prototypes make it possible to share a thread pool among multiple compression contexts.
 *  This can limit resources for applications with multiple threads where each one uses
 *  a threaded compression mode (via ZSTD_c_nbWorkers parameter).
 *  ZSTD_createThreadPool creates a new thread pool with a given number of threads.
 *  Note that the lifetime of such pool must exist while being used.
 *  ZSTD_CCtx_refThreadPool assigns a thread pool to a context (use NULL argument value
 *  to use an internal thread pool).
 *  ZSTD_freeThreadPool frees a thread pool, accepts NULL pointer.
 */
typedef struct POOL_ctx_s ZSTD_threadPool;
ZSTDLIB_STATIC_API ZSTD_threadPool* ZSTD_createThreadPool(size_t numThreads);
ZSTDLIB_STATIC_API void ZSTD_freeThreadPool (ZSTD_threadPool* pool);  /* accept NULL pointer */
ZSTDLIB_STATIC_API size_t ZSTD_CCtx_refThreadPool(ZSTD_CCtx* cctx, ZSTD_threadPool* pool);


/*
 * This API is temporary and is expected to change or disappear in the future!
 */
ZSTDLIB_STATIC_API ZSTD_CDict* ZSTD_createCDict_advanced2(
    const void* dict, size_t dictSize,
    ZSTD_dictLoadMethod_e dictLoadMethod,
    ZSTD_dictContentType_e dictContentType,
    const ZSTD_CCtx_params* cctxParams,
    ZSTD_customMem customMem);

ZSTDLIB_STATIC_API ZSTD_DDict* ZSTD_createDDict_advanced(
    const void* dict, size_t dictSize,
    ZSTD_dictLoadMethod_e dictLoadMethod,
    ZSTD_dictContentType_e dictContentType,
    ZSTD_customMem customMem);


/***************************************
*  Advanced compression functions
***************************************/

/*! ZSTD_createCDict_byReference() :
 *  Create a digested dictionary for compression
 *  Dictionary content is just referenced, not duplicated.
 *  As a consequence, `dictBuffer` **must** outlive CDict,
 *  and its content must remain unmodified throughout the lifetime of CDict.
 *  note: equivalent to ZSTD_createCDict_advanced(), with dictLoadMethod==ZSTD_dlm_byRef */
ZSTDLIB_STATIC_API ZSTD_CDict* ZSTD_createCDict_byReference(const void* dictBuffer, size_t dictSize, int compressionLevel);

/*! ZSTD_getCParams() :
 * @return ZSTD_compressionParameters structure for a selected compression level and estimated srcSize.
 * `estimatedSrcSize` value is optional, select 0 if not known */
ZSTDLIB_STATIC_API ZSTD_compressionParameters ZSTD_getCParams(int compressionLevel, unsigned long long estimatedSrcSize, size_t dictSize);

/*! ZSTD_getParams() :
 *  same as ZSTD_getCParams(), but @return a full `ZSTD_parameters` object instead of sub-component `ZSTD_compressionParameters`.
 *  All fields of `ZSTD_frameParameters` are set to default : contentSize=1, checksum=0, noDictID=0 */
ZSTDLIB_STATIC_API ZSTD_parameters ZSTD_getParams(int compressionLevel, unsigned long long estimatedSrcSize, size_t dictSize);

/*! ZSTD_checkCParams() :
 *  Ensure param values remain within authorized range.
 * @return 0 on success, or an error code (can be checked with ZSTD_isError()) */
ZSTDLIB_STATIC_API size_t ZSTD_checkCParams(ZSTD_compressionParameters params);

/*! ZSTD_adjustCParams() :
 *  optimize params for a given `srcSize` and `dictSize`.
 * `srcSize` can be unknown, in which case use ZSTD_CONTENTSIZE_UNKNOWN.
 * `dictSize` must be `0` when there is no dictionary.
 *  cPar can be invalid : all parameters will be clamped within valid range in the @return struct.
 *  This function never fails (wide contract) */
ZSTDLIB_STATIC_API ZSTD_compressionParameters ZSTD_adjustCParams(ZSTD_compressionParameters cPar, unsigned long long srcSize, size_t dictSize);

/*! ZSTD_CCtx_setCParams() :
 *  Set all parameters provided within @p cparams into the working @p cctx.
 *  Note : if modifying parameters during compression (MT mode only),
 *         note that changes to the .windowLog parameter will be ignored.
 * @return 0 on success, or an error code (can be checked with ZSTD_isError()).
 *         On failure, no parameters are updated.
 */
ZSTDLIB_STATIC_API size_t ZSTD_CCtx_setCParams(ZSTD_CCtx* cctx, ZSTD_compressionParameters cparams);

/*! ZSTD_CCtx_setFParams() :
 *  Set all parameters provided within @p fparams into the working @p cctx.
 * @return 0 on success, or an error code (can be checked with ZSTD_isError()).
 */
ZSTDLIB_STATIC_API size_t ZSTD_CCtx_setFParams(ZSTD_CCtx* cctx, ZSTD_frameParameters fparams);

/*! ZSTD_CCtx_setParams() :
 *  Set all parameters provided within @p params into the working @p cctx.
 * @return 0 on success, or an error code (can be checked with ZSTD_isError()).
 */
ZSTDLIB_STATIC_API size_t ZSTD_CCtx_setParams(ZSTD_CCtx* cctx, ZSTD_parameters params);

/*! ZSTD_compress_advanced() :
 *  Note : this function is now DEPRECATED.
 *         It can be replaced by ZSTD_compress2(), in combination with ZSTD_CCtx_setParameter() and other parameter setters.
 *  This prototype will generate compilation warnings. */
ZSTD_DEPRECATED("use ZSTD_compress2")
ZSTDLIB_STATIC_API
size_t ZSTD_compress_advanced(ZSTD_CCtx* cctx,
                              void* dst, size_t dstCapacity,
                        const void* src, size_t srcSize,
                        const void* dict,size_t dictSize,
                              ZSTD_parameters params);

/*! ZSTD_compress_usingCDict_advanced() :
 *  Note : this function is now DEPRECATED.
 *         It can be replaced by ZSTD_compress2(), in combination with ZSTD_CCtx_loadDictionary() and other parameter setters.
 *  This prototype will generate compilation warnings. */
ZSTD_DEPRECATED("use ZSTD_compress2 with ZSTD_CCtx_loadDictionary")
ZSTDLIB_STATIC_API
size_t ZSTD_compress_usingCDict_advanced(ZSTD_CCtx* cctx,
                                              void* dst, size_t dstCapacity,
                                        const void* src, size_t srcSize,
                                        const ZSTD_CDict* cdict,
                                              ZSTD_frameParameters fParams);


/*! ZSTD_CCtx_loadDictionary_byReference() :
 *  Same as ZSTD_CCtx_loadDictionary(), but dictionary content is referenced, instead of being copied into CCtx.
 *  It saves some memory, but also requires that `dict` outlives its usage within `cctx` */
ZSTDLIB_STATIC_API size_t ZSTD_CCtx_loadDictionary_byReference(ZSTD_CCtx* cctx, const void* dict, size_t dictSize);

/*! ZSTD_CCtx_loadDictionary_advanced() :
 *  Same as ZSTD_CCtx_loadDictionary(), but gives finer control over
 *  how to load the dictionary (by copy ? by reference ?)
 *  and how to interpret it (automatic ? force raw mode ? full mode only ?) */
ZSTDLIB_STATIC_API size_t ZSTD_CCtx_loadDictionary_advanced(ZSTD_CCtx* cctx, const void* dict, size_t dictSize, ZSTD_dictLoadMethod_e dictLoadMethod, ZSTD_dictContentType_e dictContentType);

/*! ZSTD_CCtx_refPrefix_advanced() :
 *  Same as ZSTD_CCtx_refPrefix(), but gives finer control over
 *  how to interpret prefix content (automatic ? force raw mode (default) ? full mode only ?) */
ZSTDLIB_STATIC_API size_t ZSTD_CCtx_refPrefix_advanced(ZSTD_CCtx* cctx, const void* prefix, size_t prefixSize, ZSTD_dictContentType_e dictContentType);

/* ===   experimental parameters   === */
/* these parameters can be used with ZSTD_setParameter()
 * they are not guaranteed to remain supported in the future */

 /* Enables rsyncable mode,
  * which makes compressed files more rsync friendly
  * by adding periodic synchronization points to the compressed data.
  * The target average block size is ZSTD_c_jobSize / 2.
  * It's possible to modify the job size to increase or decrease
  * the granularity of the synchronization point.
  * Once the jobSize is smaller than the window size,
  * it will result in compression ratio degradation.
  * NOTE 1: rsyncable mode only works when multithreading is enabled.
  * NOTE 2: rsyncable performs poorly in combination with long range mode,
  * since it will decrease the effectiveness of synchronization points,
  * though mileage may vary.
  * NOTE 3: Rsyncable mode limits maximum compression speed to ~400 MB/s.
  * If the selected compression level is already running significantly slower,
  * the overall speed won't be significantly impacted.
  */
 #define ZSTD_c_rsyncable ZSTD_c_experimentalParam1

/* Select a compression format.
 * The value must be of type ZSTD_format_e.
 * See ZSTD_format_e enum definition for details */
#define ZSTD_c_format ZSTD_c_experimentalParam2

/* Force back-reference distances to remain < windowSize,
 * even when referencing into Dictionary content (default:0) */
#define ZSTD_c_forceMaxWindow ZSTD_c_experimentalParam3

/* Controls whether the contents of a CDict
 * are used in place, or copied into the working context.
 * Accepts values from the ZSTD_dictAttachPref_e enum.
 * See the comments on that enum for an explanation of the feature. */
#define ZSTD_c_forceAttachDict ZSTD_c_experimentalParam4

/* Controlled with ZSTD_ParamSwitch_e enum.
 * Default is ZSTD_ps_auto.
 * Set to ZSTD_ps_disable to never compress literals.
 * Set to ZSTD_ps_enable to always compress literals. (Note: uncompressed literals
 * may still be emitted if huffman is not beneficial to use.)
 *
 * By default, in ZSTD_ps_auto, the library will decide at runtime whether to use
 * literals compression based on the compression parameters - specifically,
 * negative compression levels do not use literal compression.
 */
#define ZSTD_c_literalCompressionMode ZSTD_c_experimentalParam5

/* User's best guess of source size.
 * Hint is not valid when srcSizeHint == 0.
 * There is no guarantee that hint is close to actual source size,
 * but compression ratio may regress significantly if guess considerably underestimates */
#define ZSTD_c_srcSizeHint ZSTD_c_experimentalParam7

/* Controls whether the new and experimental "dedicated dictionary search
 * structure" can be used. This feature is still rough around the edges, be
 * prepared for surprising behavior!
 *
 * How to use it:
 *
 * When using a CDict, whether to use this feature or not is controlled at
 * CDict creation, and it must be set in a CCtxParams set passed into that
 * construction (via ZSTD_createCDict_advanced2()). A compression will then
 * use the feature or not based on how the CDict was constructed; the value of
 * this param, set in the CCtx, will have no effect.
 *
 * However, when a dictionary buffer is passed into a CCtx, such as via
 * ZSTD_CCtx_loadDictionary(), this param can be set on the CCtx to control
 * whether the CDict that is created internally can use the feature or not.
 *
 * What it does:
 *
 * Normally, the internal data structures of the CDict are analogous to what
 * would be stored in a CCtx after compressing the contents of a dictionary.
 * To an approximation, a compression using a dictionary can then use those
 * data structures to simply continue what is effectively a streaming
 * compression where the simulated compression of the dictionary left off.
 * Which is to say, the search structures in the CDict are normally the same
 * format as in the CCtx.
 *
 * It is possible to do better, since the CDict is not like a CCtx: the search
 * structures are written once during CDict creation, and then are only read
 * after that, while the search structures in the CCtx are both read and
 * written as the compression goes along. This means we can choose a search
 * structure for the dictionary that is read-optimized.
 *
 * This feature enables the use of that different structure.
 *
 * Note that some of the members of the ZSTD_compressionParameters struct have
 * different semantics and constraints in the dedicated search structure. It is
 * highly recommended that you simply set a compression level in the CCtxParams
 * you pass into the CDict creation call, and avoid messing with the cParams
 * directly.
 *
 * Effects:
 *
 * This will only have any effect when the selected ZSTD_strategy
 * implementation supports this feature. Currently, that's limited to
 * ZSTD_greedy, ZSTD_lazy, and ZSTD_lazy2.
 *
 * Note that this means that the CDict tables can no longer be copied into the
 * CCtx, so the dict attachment mode ZSTD_dictForceCopy will no longer be
 * usable. The dictionary can only be attached or reloaded.
 *
 * In general, you should expect compression to be faster--sometimes very much
 * so--and CDict creation to be slightly slower. Eventually, we will probably
 * make this mode the default.
 */
#define ZSTD_c_enableDedicatedDictSearch ZSTD_c_experimentalParam8

/* ZSTD_c_stableInBuffer
 * Experimental parameter.
 * Default is 0 == disabled. Set to 1 to enable.
 *
 * Tells the compressor that input data presented with ZSTD_inBuffer
 * will ALWAYS be the same between calls.
 * Technically, the @src pointer must never be changed,
 * and the @pos field can only be updated by zstd.
 * However, it's possible to increase the @size field,
 * allowing scenarios where more data can be appended after compressions starts.
 * These conditions are checked by the compressor,
 * and compression will fail if they are not respected.
 * Also, data in the ZSTD_inBuffer within the range [src, src + pos)
 * MUST not be modified during compression or it will result in data corruption.
 *
 * When this flag is enabled zstd won't allocate an input window buffer,
 * because the user guarantees it can reference the ZSTD_inBuffer until
 * the frame is complete. But, it will still allocate an output buffer
 * large enough to fit a block (see ZSTD_c_stableOutBuffer). This will also
 * avoid the memcpy() from the input buffer to the input window buffer.
 *
 * NOTE: So long as the ZSTD_inBuffer always points to valid memory, using
 * this flag is ALWAYS memory safe, and will never access out-of-bounds
 * memory. However, compression WILL fail if conditions are not respected.
 *
 * WARNING: The data in the ZSTD_inBuffer in the range [src, src + pos) MUST
 * not be modified during compression or it will result in data corruption.
 * This is because zstd needs to reference data in the ZSTD_inBuffer to find
 * matches. Normally zstd maintains its own window buffer for this purpose,
 * but passing this flag tells zstd to rely on user provided buffer instead.
 */
#define ZSTD_c_stableInBuffer ZSTD_c_experimentalParam9

/* ZSTD_c_stableOutBuffer
 * Experimental parameter.
 * Default is 0 == disabled. Set to 1 to enable.
 *
 * Tells he compressor that the ZSTD_outBuffer will not be resized between
 * calls. Specifically: (out.size - out.pos) will never grow. This gives the
 * compressor the freedom to say: If the compressed data doesn't fit in the
 * output buffer then return ZSTD_error_dstSizeTooSmall. This allows us to
 * always decompress directly into the output buffer, instead of decompressing
 * into an internal buffer and copying to the output buffer.
 *
 * When this flag is enabled zstd won't allocate an output buffer, because
 * it can write directly to the ZSTD_outBuffer. It will still allocate the
 * input window buffer (see ZSTD_c_stableInBuffer).
 *
 * Zstd will check that (out.size - out.pos) never grows and return an error
 * if it does. While not strictly necessary, this should prevent surprises.
 */
#define ZSTD_c_stableOutBuffer ZSTD_c_experimentalParam10

/* ZSTD_c_blockDelimiters
 * Default is 0 == ZSTD_sf_noBlockDelimiters.
 *
 * For use with sequence compression API: ZSTD_compressSequences().
 *
 * Designates whether or not the given array of ZSTD_Sequence contains block delimiters
 * and last literals, which are defined as sequences with offset == 0 and matchLength == 0.
 * See the definition of ZSTD_Sequence for more specifics.
 */
#define ZSTD_c_blockDelimiters ZSTD_c_experimentalParam11

/* ZSTD_c_validateSequences
 * Default is 0 == disabled. Set to 1 to enable sequence validation.
 *
 * For use with sequence compression API: ZSTD_compressSequences*().
 * Designates whether or not provided sequences are validated within ZSTD_compressSequences*()
 * during function execution.
 *
 * When Sequence validation is disabled (default), Sequences are compressed as-is,
 * so they must correct, otherwise it would result in a corruption error.
 *
 * Sequence validation adds some protection, by ensuring that all values respect boundary conditions.
 * If a Sequence is detected invalid (see doc/zstd_compression_format.md for
 * specifics regarding offset/matchlength requirements) then the function will bail out and
 * return an error.
 */
#define ZSTD_c_validateSequences ZSTD_c_experimentalParam12

/* ZSTD_c_blockSplitterLevel
 * note: this parameter only influences the first splitter stage,
 *       which is active before producing the sequences.
 *       ZSTD_c_splitAfterSequences controls the next splitter stage,
 *       which is active after sequence production.
 *       Note that both can be combined.
 * Allowed values are between 0 and ZSTD_BLOCKSPLITTER_LEVEL_MAX included.
 * 0 means "auto", which will select a value depending on current ZSTD_c_strategy.
 * 1 means no splitting.
 * Then, values from 2 to 6 are sorted in increasing cpu load order.
 *
 * Note that currently the first block is never split,
 * to ensure expansion guarantees in presence of incompressible data.
 */
#define ZSTD_BLOCKSPLITTER_LEVEL_MAX 6
#define ZSTD_c_blockSplitterLevel ZSTD_c_experimentalParam20

/* ZSTD_c_splitAfterSequences
 * This is a stronger splitter algorithm,
 * based on actual sequences previously produced by the selected parser.
 * It's also slower, and as a consequence, mostly used for high compression levels.
 * While the post-splitter does overlap with the pre-splitter,
 * both can nonetheless be combined,
 * notably with ZSTD_c_blockSplitterLevel at ZSTD_BLOCKSPLITTER_LEVEL_MAX,
 * resulting in higher compression ratio than just one of them.
 *
 * Default is ZSTD_ps_auto.
 * Set to ZSTD_ps_disable to never use block splitter.
 * Set to ZSTD_ps_enable to always use block splitter.
 *
 * By default, in ZSTD_ps_auto, the library will decide at runtime whether to use
 * block splitting based on the compression parameters.
 */
#define ZSTD_c_splitAfterSequences ZSTD_c_experimentalParam13

/* ZSTD_c_useRowMatchFinder
 * Controlled with ZSTD_ParamSwitch_e enum.
 * Default is ZSTD_ps_auto.
 * Set to ZSTD_ps_disable to never use row-based matchfinder.
 * Set to ZSTD_ps_enable to force usage of row-based matchfinder.
 *
 * By default, in ZSTD_ps_auto, the library will decide at runtime whether to use
 * the row-based matchfinder based on support for SIMD instructions and the window log.
 * Note that this only pertains to compression strategies: greedy, lazy, and lazy2
 */
#define ZSTD_c_useRowMatchFinder ZSTD_c_experimentalParam14

/* ZSTD_c_deterministicRefPrefix
 * Default is 0 == disabled. Set to 1 to enable.
 *
 * Zstd produces different results for prefix compression when the prefix is
 * directly adjacent to the data about to be compressed vs. when it isn't.
 * This is because zstd detects that the two buffers are contiguous and it can
 * use a more efficient match finding algorithm. However, this produces different
 * results than when the two buffers are non-contiguous. This flag forces zstd
 * to always load the prefix in non-contiguous mode, even if it happens to be
 * adjacent to the data, to guarantee determinism.
 *
 * If you really care about determinism when using a dictionary or prefix,
 * like when doing delta compression, you should select this option. It comes
 * at a speed penalty of about ~2.5% if the dictionary and data happened to be
 * contiguous, and is free if they weren't contiguous. We don't expect that
 * intentionally making the dictionary and data contiguous will be worth the
 * cost to memcpy() the data.
 */
#define ZSTD_c_deterministicRefPrefix ZSTD_c_experimentalParam15

/* ZSTD_c_prefetchCDictTables
 * Controlled with ZSTD_ParamSwitch_e enum. Default is ZSTD_ps_auto.
 *
 * In some situations, zstd uses CDict tables in-place rather than copying them
 * into the working context. (See docs on ZSTD_dictAttachPref_e above for details).
 * In such situations, compression speed is seriously impacted when CDict tables are
 * "cold" (outside CPU cache). This parameter instructs zstd to prefetch CDict tables
 * when they are used in-place.
 *
 * For sufficiently small inputs, the cost of the prefetch will outweigh the benefit.
 * For sufficiently large inputs, zstd will by default memcpy() CDict tables
 * into the working context, so there is no need to prefetch. This parameter is
 * targeted at a middle range of input sizes, where a prefetch is cheap enough to be
 * useful but memcpy() is too expensive. The exact range of input sizes where this
 * makes sense is best determined by careful experimentation.
 *
 * Note: for this parameter, ZSTD_ps_auto is currently equivalent to ZSTD_ps_disable,
 * but in the future zstd may conditionally enable this feature via an auto-detection
 * heuristic for cold CDicts.
 * Use ZSTD_ps_disable to opt out of prefetching under any circumstances.
 */
#define ZSTD_c_prefetchCDictTables ZSTD_c_experimentalParam16

/* ZSTD_c_enableSeqProducerFallback
 * Allowed values are 0 (disable) and 1 (enable). The default setting is 0.
 *
 * Controls whether zstd will fall back to an internal sequence producer if an
 * external sequence producer is registered and returns an error code. This fallback
 * is block-by-block: the internal sequence producer will only be called for blocks
 * where the external sequence producer returns an error code. Fallback parsing will
 * follow any other cParam settings, such as compression level, the same as in a
 * normal (fully-internal) compression operation.
 *
 * The user is strongly encouraged to read the full Block-Level Sequence Producer API
 * documentation (below) before setting this parameter. */
#define ZSTD_c_enableSeqProducerFallback ZSTD_c_experimentalParam17

/* ZSTD_c_maxBlockSize
 * Allowed values are between 1KB and ZSTD_BLOCKSIZE_MAX (128KB).
 * The default is ZSTD_BLOCKSIZE_MAX, and setting to 0 will set to the default.
 *
 * This parameter can be used to set an upper bound on the blocksize
 * that overrides the default ZSTD_BLOCKSIZE_MAX. It cannot be used to set upper
 * bounds greater than ZSTD_BLOCKSIZE_MAX or bounds lower than 1KB (will make
 * compressBound() inaccurate). Only currently meant to be used for testing.
 */
#define ZSTD_c_maxBlockSize ZSTD_c_experimentalParam18

/* ZSTD_c_repcodeResolution
 * This parameter only has an effect if ZSTD_c_blockDelimiters is
 * set to ZSTD_sf_explicitBlockDelimiters (may change in the future).
 *
 * This parameter affects how zstd parses external sequences,
 * provided via the ZSTD_compressSequences*() API
 * or from an external block-level sequence producer.
 *
 * If set to ZSTD_ps_enable, the library will check for repeated offsets within
 * external sequences, even if those repcodes are not explicitly indicated in
 * the "rep" field. Note that this is the only way to exploit repcode matches
 * while using compressSequences*() or an external sequence producer, since zstd
 * currently ignores the "rep" field of external sequences.
 *
 * If set to ZSTD_ps_disable, the library will not exploit repeated offsets in
 * external sequences, regardless of whether the "rep" field has been set. This
 * reduces sequence compression overhead by about 25% while sacrificing some
 * compression ratio.
 *
 * The default value is ZSTD_ps_auto, for which the library will enable/disable
 * based on compression level (currently: level<10 disables, level>=10 enables).
 */
#define ZSTD_c_repcodeResolution ZSTD_c_experimentalParam19
#define ZSTD_c_searchForExternalRepcodes ZSTD_c_experimentalParam19 /* older name */


/*! ZSTD_CCtx_getParameter() :
 *  Get the requested compression parameter value, selected by enum ZSTD_cParameter,
 *  and store it into int* value.
 * @return : 0, or an error code (which can be tested with ZSTD_isError()).
 */
ZSTDLIB_STATIC_API size_t ZSTD_CCtx_getParameter(const ZSTD_CCtx* cctx, ZSTD_cParameter param, int* value);


/*! ZSTD_CCtx_params :
 *  Quick howto :
 *  - ZSTD_createCCtxParams() : Create a ZSTD_CCtx_params structure
 *  - ZSTD_CCtxParams_setParameter() : Push parameters one by one into
 *                                     an existing ZSTD_CCtx_params structure.
 *                                     This is similar to
 *                                     ZSTD_CCtx_setParameter().
 *  - ZSTD_CCtx_setParametersUsingCCtxParams() : Apply parameters to
 *                                    an existing CCtx.
 *                                    These parameters will be applied to
 *                                    all subsequent frames.
 *  - ZSTD_compressStream2() : Do compression using the CCtx.
 *  - ZSTD_freeCCtxParams() : Free the memory, accept NULL pointer.
 *
 *  This can be used with ZSTD_estimateCCtxSize_advanced_usingCCtxParams()
 *  for static allocation of CCtx for single-threaded compression.
 */
ZSTDLIB_STATIC_API ZSTD_CCtx_params* ZSTD_createCCtxParams(void);
ZSTDLIB_STATIC_API size_t ZSTD_freeCCtxParams(ZSTD_CCtx_params* params);  /* accept NULL pointer */

/*! ZSTD_CCtxParams_reset() :
 *  Reset params to default values.
 */
ZSTDLIB_STATIC_API size_t ZSTD_CCtxParams_reset(ZSTD_CCtx_params* params);

/*! ZSTD_CCtxParams_init() :
 *  Initializes the compression parameters of cctxParams according to
 *  compression level. All other parameters are reset to their default values.
 */
ZSTDLIB_STATIC_API size_t ZSTD_CCtxParams_init(ZSTD_CCtx_params* cctxParams, int compressionLevel);

/*! ZSTD_CCtxParams_init_advanced() :
 *  Initializes the compression and frame parameters of cctxParams according to
 *  params. All other parameters are reset to their default values.
 */
ZSTDLIB_STATIC_API size_t ZSTD_CCtxParams_init_advanced(ZSTD_CCtx_params* cctxParams, ZSTD_parameters params);

/*! ZSTD_CCtxParams_setParameter() : Requires v1.4.0+
 *  Similar to ZSTD_CCtx_setParameter.
 *  Set one compression parameter, selected by enum ZSTD_cParameter.
 *  Parameters must be applied to a ZSTD_CCtx using
 *  ZSTD_CCtx_setParametersUsingCCtxParams().
 * @result : a code representing success or failure (which can be tested with
 *           ZSTD_isError()).
 */
ZSTDLIB_STATIC_API size_t ZSTD_CCtxParams_setParameter(ZSTD_CCtx_params* params, ZSTD_cParameter param, int value);

/*! ZSTD_CCtxParams_getParameter() :
 * Similar to ZSTD_CCtx_getParameter.
 * Get the requested value of one compression parameter, selected by enum ZSTD_cParameter.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 */
ZSTDLIB_STATIC_API size_t ZSTD_CCtxParams_getParameter(const ZSTD_CCtx_params* params, ZSTD_cParameter param, int* value);

/*! ZSTD_CCtx_setParametersUsingCCtxParams() :
 *  Apply a set of ZSTD_CCtx_params to the compression context.
 *  This can be done even after compression is started,
 *    if nbWorkers==0, this will have no impact until a new compression is started.
 *    if nbWorkers>=1, new parameters will be picked up at next job,
 *       with a few restrictions (windowLog, pledgedSrcSize, nbWorkers, jobSize, and overlapLog are not updated).
 */
ZSTDLIB_STATIC_API size_t ZSTD_CCtx_setParametersUsingCCtxParams(
        ZSTD_CCtx* cctx, const ZSTD_CCtx_params* params);

/*! ZSTD_compressStream2_simpleArgs() :
 *  Same as ZSTD_compressStream2(),
 *  but using only integral types as arguments.
 *  This variant might be helpful for binders from dynamic languages
 *  which have troubles handling structures containing memory pointers.
 */
ZSTDLIB_STATIC_API size_t ZSTD_compressStream2_simpleArgs (
                            ZSTD_CCtx* cctx,
                            void* dst, size_t dstCapacity, size_t* dstPos,
                      const void* src, size_t srcSize, size_t* srcPos,
                            ZSTD_EndDirective endOp);


/***************************************
*  Advanced decompression functions
***************************************/

/*! ZSTD_isFrame() :
 *  Tells if the content of `buffer` starts with a valid Frame Identifier.
 *  Note : Frame Identifier is 4 bytes. If `size < 4`, @return will always be 0.
 *  Note 2 : Legacy Frame Identifiers are considered valid only if Legacy Support is enabled.
 *  Note 3 : Skippable Frame Identifiers are considered valid. */
ZSTDLIB_STATIC_API unsigned ZSTD_isFrame(const void* buffer, size_t size);

/*! ZSTD_createDDict_byReference() :
 *  Create a digested dictionary, ready to start decompression operation without startup delay.
 *  Dictionary content is referenced, and therefore stays in dictBuffer.
 *  It is important that dictBuffer outlives DDict,
 *  it must remain read accessible throughout the lifetime of DDict */
ZSTDLIB_STATIC_API ZSTD_DDict* ZSTD_createDDict_byReference(const void* dictBuffer, size_t dictSize);

/*! ZSTD_DCtx_loadDictionary_byReference() :
 *  Same as ZSTD_DCtx_loadDictionary(),
 *  but references `dict` content instead of copying it into `dctx`.
 *  This saves memory if `dict` remains around.,
 *  However, it's imperative that `dict` remains accessible (and unmodified) while being used, so it must outlive decompression. */
ZSTDLIB_STATIC_API size_t ZSTD_DCtx_loadDictionary_byReference(ZSTD_DCtx* dctx, const void* dict, size_t dictSize);

/*! ZSTD_DCtx_loadDictionary_advanced() :
 *  Same as ZSTD_DCtx_loadDictionary(),
 *  but gives direct control over
 *  how to load the dictionary (by copy ? by reference ?)
 *  and how to interpret it (automatic ? force raw mode ? full mode only ?). */
ZSTDLIB_STATIC_API size_t ZSTD_DCtx_loadDictionary_advanced(ZSTD_DCtx* dctx, const void* dict, size_t dictSize, ZSTD_dictLoadMethod_e dictLoadMethod, ZSTD_dictContentType_e dictContentType);

/*! ZSTD_DCtx_refPrefix_advanced() :
 *  Same as ZSTD_DCtx_refPrefix(), but gives finer control over
 *  how to interpret prefix content (automatic ? force raw mode (default) ? full mode only ?) */
ZSTDLIB_STATIC_API size_t ZSTD_DCtx_refPrefix_advanced(ZSTD_DCtx* dctx, const void* prefix, size_t prefixSize, ZSTD_dictContentType_e dictContentType);

/*! ZSTD_DCtx_setMaxWindowSize() :
 *  Refuses allocating internal buffers for frames requiring a window size larger than provided limit.
 *  This protects a decoder context from reserving too much memory for itself (potential attack scenario).
 *  This parameter is only useful in streaming mode, since no internal buffer is allocated in single-pass mode.
 *  By default, a decompression context accepts all window sizes <= (1 << ZSTD_WINDOWLOG_LIMIT_DEFAULT)
 * @return : 0, or an error code (which can be tested using ZSTD_isError()).
 */
ZSTDLIB_STATIC_API size_t ZSTD_DCtx_setMaxWindowSize(ZSTD_DCtx* dctx, size_t maxWindowSize);

/*! ZSTD_DCtx_getParameter() :
 *  Get the requested decompression parameter value, selected by enum ZSTD_dParameter,
 *  and store it into int* value.
 * @return : 0, or an error code (which can be tested with ZSTD_isError()).
 */
ZSTDLIB_STATIC_API size_t ZSTD_DCtx_getParameter(ZSTD_DCtx* dctx, ZSTD_dParameter param, int* value);

/* ZSTD_d_format
 * experimental parameter,
 * allowing selection between ZSTD_format_e input compression formats
 */
#define ZSTD_d_format ZSTD_d_experimentalParam1
/* ZSTD_d_stableOutBuffer
 * Experimental parameter.
 * Default is 0 == disabled. Set to 1 to enable.
 *
 * Tells the decompressor that the ZSTD_outBuffer will ALWAYS be the same
 * between calls, except for the modifications that zstd makes to pos (the
 * caller must not modify pos). This is checked by the decompressor, and
 * decompression will fail if it ever changes. Therefore the ZSTD_outBuffer
 * MUST be large enough to fit the entire decompressed frame. This will be
 * checked when the frame content size is known. The data in the ZSTD_outBuffer
 * in the range [dst, dst + pos) MUST not be modified during decompression
 * or you will get data corruption.
 *
 * When this flag is enabled zstd won't allocate an output buffer, because
 * it can write directly to the ZSTD_outBuffer, but it will still allocate
 * an input buffer large enough to fit any compressed block. This will also
 * avoid the memcpy() from the internal output buffer to the ZSTD_outBuffer.
 * If you need to avoid the input buffer allocation use the buffer-less
 * streaming API.
 *
 * NOTE: So long as the ZSTD_outBuffer always points to valid memory, using
 * this flag is ALWAYS memory safe, and will never access out-of-bounds
 * memory. However, decompression WILL fail if you violate the preconditions.
 *
 * WARNING: The data in the ZSTD_outBuffer in the range [dst, dst + pos) MUST
 * not be modified during decompression or you will get data corruption. This
 * is because zstd needs to reference data in the ZSTD_outBuffer to regenerate
 * matches. Normally zstd maintains its own buffer for this purpose, but passing
 * this flag tells zstd to use the user provided buffer.
 */
#define ZSTD_d_stableOutBuffer ZSTD_d_experimentalParam2

/* ZSTD_d_forceIgnoreChecksum
 * Experimental parameter.
 * Default is 0 == disabled. Set to 1 to enable
 *
 * Tells the decompressor to skip checksum validation during decompression, regardless
 * of whether checksumming was specified during compression. This offers some
 * slight performance benefits, and may be useful for debugging.
 * Param has values of type ZSTD_forceIgnoreChecksum_e
 */
#define ZSTD_d_forceIgnoreChecksum ZSTD_d_experimentalParam3

/* ZSTD_d_refMultipleDDicts
 * Experimental parameter.
 * Default is 0 == disabled. Set to 1 to enable
 *
 * If enabled and dctx is allocated on the heap, then additional memory will be allocated
 * to store references to multiple ZSTD_DDict. That is, multiple calls of ZSTD_refDDict()
 * using a given ZSTD_DCtx, rather than overwriting the previous DDict reference, will instead
 * store all references. At decompression time, the appropriate dictID is selected
 * from the set of DDicts based on the dictID in the frame.
 *
 * Usage is simply calling ZSTD_refDDict() on multiple dict buffers.
 *
 * Param has values of byte ZSTD_refMultipleDDicts_e
 *
 * WARNING: Enabling this parameter and calling ZSTD_DCtx_refDDict(), will trigger memory
 * allocation for the hash table. ZSTD_freeDCtx() also frees this memory.
 * Memory is allocated as per ZSTD_DCtx::customMem.
 *
 * Although this function allocates memory for the table, the user is still responsible for
 * memory management of the underlying ZSTD_DDict* themselves.
 */
#define ZSTD_d_refMultipleDDicts ZSTD_d_experimentalParam4

/* ZSTD_d_disableHuffmanAssembly
 * Set to 1 to disable the Huffman assembly implementation.
 * The default value is 0, which allows zstd to use the Huffman assembly
 * implementation if available.
 *
 * This parameter can be used to disable Huffman assembly at runtime.
 * If you want to disable it at compile time you can define the macro
 * ZSTD_DISABLE_ASM.
 */
#define ZSTD_d_disableHuffmanAssembly ZSTD_d_experimentalParam5

/* ZSTD_d_maxBlockSize
 * Allowed values are between 1KB and ZSTD_BLOCKSIZE_MAX (128KB).
 * The default is ZSTD_BLOCKSIZE_MAX, and setting to 0 will set to the default.
 *
 * Forces the decompressor to reject blocks whose content size is
 * larger than the configured maxBlockSize. When maxBlockSize is
 * larger than the windowSize, the windowSize is used instead.
 * This saves memory on the decoder when you know all blocks are small.
 *
 * This option is typically used in conjunction with ZSTD_c_maxBlockSize.
 *
 * WARNING: This causes the decoder to reject otherwise valid frames
 * that have block sizes larger than the configured maxBlockSize.
 */
#define ZSTD_d_maxBlockSize ZSTD_d_experimentalParam6


/*! ZSTD_DCtx_setFormat() :
 *  This function is REDUNDANT. Prefer ZSTD_DCtx_setParameter().
 *  Instruct the decoder context about what kind of data to decode next.
 *  This instruction is mandatory to decode data without a fully-formed header,
 *  such ZSTD_f_zstd1_magicless for example.
 * @return : 0, or an error code (which can be tested using ZSTD_isError()). */
ZSTD_DEPRECATED("use ZSTD_DCtx_setParameter() instead")
ZSTDLIB_STATIC_API
size_t ZSTD_DCtx_setFormat(ZSTD_DCtx* dctx, ZSTD_format_e format);

/*! ZSTD_decompressStream_simpleArgs() :
 *  Same as ZSTD_decompressStream(),
 *  but using only integral types as arguments.
 *  This can be helpful for binders from dynamic languages
 *  which have troubles handling structures containing memory pointers.
 */
ZSTDLIB_STATIC_API size_t ZSTD_decompressStream_simpleArgs (
                            ZSTD_DCtx* dctx,
                            void* dst, size_t dstCapacity, size_t* dstPos,
                      const void* src, size_t srcSize, size_t* srcPos);


/********************************************************************
*  Advanced streaming functions
*  Warning : most of these functions are now redundant with the Advanced API.
*  Once Advanced API reaches "stable" status,
*  redundant functions will be deprecated, and then at some point removed.
********************************************************************/

/*=====   Advanced Streaming compression functions  =====*/

/*! ZSTD_initCStream_srcSize() :
 * This function is DEPRECATED, and equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_refCDict(zcs, NULL); // clear the dictionary (if any)
 *     ZSTD_CCtx_setParameter(zcs, ZSTD_c_compressionLevel, compressionLevel);
 *     ZSTD_CCtx_setPledgedSrcSize(zcs, pledgedSrcSize);
 *
 * pledgedSrcSize must be correct. If it is not known at init time, use
 * ZSTD_CONTENTSIZE_UNKNOWN. Note that, for compatibility with older programs,
 * "0" also disables frame content size field. It may be enabled in the future.
 * This prototype will generate compilation warnings.
 */
ZSTD_DEPRECATED("use ZSTD_CCtx_reset, see zstd.h for detailed instructions")
ZSTDLIB_STATIC_API
size_t ZSTD_initCStream_srcSize(ZSTD_CStream* zcs,
                         int compressionLevel,
                         unsigned long long pledgedSrcSize);

/*! ZSTD_initCStream_usingDict() :
 * This function is DEPRECATED, and is equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_setParameter(zcs, ZSTD_c_compressionLevel, compressionLevel);
 *     ZSTD_CCtx_loadDictionary(zcs, dict, dictSize);
 *
 * Creates of an internal CDict (incompatible with static CCtx), except if
 * dict == NULL or dictSize < 8, in which case no dict is used.
 * Note: dict is loaded with ZSTD_dct_auto (treated as a full zstd dictionary if
 * it begins with ZSTD_MAGIC_DICTIONARY, else as raw content) and ZSTD_dlm_byCopy.
 * This prototype will generate compilation warnings.
 */
ZSTD_DEPRECATED("use ZSTD_CCtx_reset, see zstd.h for detailed instructions")
ZSTDLIB_STATIC_API
size_t ZSTD_initCStream_usingDict(ZSTD_CStream* zcs,
                     const void* dict, size_t dictSize,
                           int compressionLevel);

/*! ZSTD_initCStream_advanced() :
 * This function is DEPRECATED, and is equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_setParams(zcs, params);
 *     ZSTD_CCtx_setPledgedSrcSize(zcs, pledgedSrcSize);
 *     ZSTD_CCtx_loadDictionary(zcs, dict, dictSize);
 *
 * dict is loaded with ZSTD_dct_auto and ZSTD_dlm_byCopy.
 * pledgedSrcSize must be correct.
 * If srcSize is not known at init time, use value ZSTD_CONTENTSIZE_UNKNOWN.
 * This prototype will generate compilation warnings.
 */
ZSTD_DEPRECATED("use ZSTD_CCtx_reset, see zstd.h for detailed instructions")
ZSTDLIB_STATIC_API
size_t ZSTD_initCStream_advanced(ZSTD_CStream* zcs,
                    const void* dict, size_t dictSize,
                          ZSTD_parameters params,
                          unsigned long long pledgedSrcSize);

/*! ZSTD_initCStream_usingCDict() :
 * This function is DEPRECATED, and equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_refCDict(zcs, cdict);
 *
 * note : cdict will just be referenced, and must outlive compression session
 * This prototype will generate compilation warnings.
 */
ZSTD_DEPRECATED("use ZSTD_CCtx_reset and ZSTD_CCtx_refCDict, see zstd.h for detailed instructions")
ZSTDLIB_STATIC_API
size_t ZSTD_initCStream_usingCDict(ZSTD_CStream* zcs, const ZSTD_CDict* cdict);

/*! ZSTD_initCStream_usingCDict_advanced() :
 *   This function is DEPRECATED, and is equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_setFParams(zcs, fParams);
 *     ZSTD_CCtx_setPledgedSrcSize(zcs, pledgedSrcSize);
 *     ZSTD_CCtx_refCDict(zcs, cdict);
 *
 * same as ZSTD_initCStream_usingCDict(), with control over frame parameters.
 * pledgedSrcSize must be correct. If srcSize is not known at init time, use
 * value ZSTD_CONTENTSIZE_UNKNOWN.
 * This prototype will generate compilation warnings.
 */
ZSTD_DEPRECATED("use ZSTD_CCtx_reset and ZSTD_CCtx_refCDict, see zstd.h for detailed instructions")
ZSTDLIB_STATIC_API
size_t ZSTD_initCStream_usingCDict_advanced(ZSTD_CStream* zcs,
                               const ZSTD_CDict* cdict,
                                     ZSTD_frameParameters fParams,
                                     unsigned long long pledgedSrcSize);

/*! ZSTD_resetCStream() :
 * This function is DEPRECATED, and is equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_setPledgedSrcSize(zcs, pledgedSrcSize);
 * Note: ZSTD_resetCStream() interprets pledgedSrcSize == 0 as ZSTD_CONTENTSIZE_UNKNOWN, but
 *       ZSTD_CCtx_setPledgedSrcSize() does not do the same, so ZSTD_CONTENTSIZE_UNKNOWN must be
 *       explicitly specified.
 *
 *  start a new frame, using same parameters from previous frame.
 *  This is typically useful to skip dictionary loading stage, since it will reuse it in-place.
 *  Note that zcs must be init at least once before using ZSTD_resetCStream().
 *  If pledgedSrcSize is not known at reset time, use macro ZSTD_CONTENTSIZE_UNKNOWN.
 *  If pledgedSrcSize > 0, its value must be correct, as it will be written in header, and controlled at the end.
 *  For the time being, pledgedSrcSize==0 is interpreted as "srcSize unknown" for compatibility with older programs,
 *  but it will change to mean "empty" in future version, so use macro ZSTD_CONTENTSIZE_UNKNOWN instead.
 * @return : 0, or an error code (which can be tested using ZSTD_isError())
 *  This prototype will generate compilation warnings.
 */
ZSTD_DEPRECATED("use ZSTD_CCtx_reset, see zstd.h for detailed instructions")
ZSTDLIB_STATIC_API
size_t ZSTD_resetCStream(ZSTD_CStream* zcs, unsigned long long pledgedSrcSize);


typedef struct {
    unsigned long long ingested;   /* nb input bytes read and buffered */
    unsigned long long consumed;   /* nb input bytes actually compressed */
    unsigned long long produced;   /* nb of compressed bytes generated and buffered */
    unsigned long long flushed;    /* nb of compressed bytes flushed : not provided; can be tracked from caller side */
    unsigned currentJobID;         /* MT only : latest started job nb */
    unsigned nbActiveWorkers;      /* MT only : nb of workers actively compressing at probe time */
} ZSTD_frameProgression;

/* ZSTD_getFrameProgression() :
 * tells how much data has been ingested (read from input)
 * consumed (input actually compressed) and produced (output) for current frame.
 * Note : (ingested - consumed) is amount of input data buffered internally, not yet compressed.
 * Aggregates progression inside active worker threads.
 */
ZSTDLIB_STATIC_API ZSTD_frameProgression ZSTD_getFrameProgression(const ZSTD_CCtx* cctx);

/*! ZSTD_toFlushNow() :
 *  Tell how many bytes are ready to be flushed immediately.
 *  Useful for multithreading scenarios (nbWorkers >= 1).
 *  Probe the oldest active job, defined as oldest job not yet entirely flushed,
 *  and check its output buffer.
 * @return : amount of data stored in oldest job and ready to be flushed immediately.
 *  if @return == 0, it means either :
 *  + there is no active job (could be checked with ZSTD_frameProgression()), or
 *  + oldest job is still actively compressing data,
 *    but everything it has produced has also been flushed so far,
 *    therefore flush speed is limited by production speed of oldest job
 *    irrespective of the speed of concurrent (and newer) jobs.
 */
ZSTDLIB_STATIC_API size_t ZSTD_toFlushNow(ZSTD_CCtx* cctx);


/*=====   Advanced Streaming decompression functions  =====*/

/*!
 * This function is deprecated, and is equivalent to:
 *
 *     ZSTD_DCtx_reset(zds, ZSTD_reset_session_only);
 *     ZSTD_DCtx_loadDictionary(zds, dict, dictSize);
 *
 * note: no dictionary will be used if dict == NULL or dictSize < 8
 */
ZSTD_DEPRECATED("use ZSTD_DCtx_reset + ZSTD_DCtx_loadDictionary, see zstd.h for detailed instructions")
ZSTDLIB_STATIC_API size_t ZSTD_initDStream_usingDict(ZSTD_DStream* zds, const void* dict, size_t dictSize);

/*!
 * This function is deprecated, and is equivalent to:
 *
 *     ZSTD_DCtx_reset(zds, ZSTD_reset_session_only);
 *     ZSTD_DCtx_refDDict(zds, ddict);
 *
 * note : ddict is referenced, it must outlive decompression session
 */
ZSTD_DEPRECATED("use ZSTD_DCtx_reset + ZSTD_DCtx_refDDict, see zstd.h for detailed instructions")
ZSTDLIB_STATIC_API size_t ZSTD_initDStream_usingDDict(ZSTD_DStream* zds, const ZSTD_DDict* ddict);

/*!
 * This function is deprecated, and is equivalent to:
 *
 *     ZSTD_DCtx_reset(zds, ZSTD_reset_session_only);
 *
 * reuse decompression parameters from previous init; saves dictionary loading
 */
ZSTD_DEPRECATED("use ZSTD_DCtx_reset, see zstd.h for detailed instructions")
ZSTDLIB_STATIC_API size_t ZSTD_resetDStream(ZSTD_DStream* zds);


/* ********************* BLOCK-LEVEL SEQUENCE PRODUCER API *********************
 *
 * *** OVERVIEW ***
 * The Block-Level Sequence Producer API allows users to provide their own custom
 * sequence producer which libzstd invokes to process each block. The produced list
 * of sequences (literals and matches) is then post-processed by libzstd to produce
 * valid compressed blocks.
 *
 * This block-level offload API is a more granular complement of the existing
 * frame-level offload API compressSequences() (introduced in v1.5.1). It offers
 * an easier migration story for applications already integrated with libzstd: the
 * user application continues to invoke the same compression functions
 * ZSTD_compress2() or ZSTD_compressStream2() as usual, and transparently benefits
 * from the specific advantages of the external sequence producer. For example,
 * the sequence producer could be tuned to take advantage of known characteristics
 * of the input, to offer better speed / ratio, or could leverage hardware
 * acceleration not available within libzstd itself.
 *
 * See contrib/externalSequenceProducer for an example program employing the
 * Block-Level Sequence Producer API.
 *
 * *** USAGE ***
 * The user is responsible for implementing a function of type
 * ZSTD_sequenceProducer_F. For each block, zstd will pass the following
 * arguments to the user-provided function:
 *
 *   - sequenceProducerState: a pointer to a user-managed state for the sequence
 *     producer.
 *
 *   - outSeqs, outSeqsCapacity: an output buffer for the sequence producer.
 *     outSeqsCapacity is guaranteed >= ZSTD_sequenceBound(srcSize). The memory
 *     backing outSeqs is managed by the CCtx.
 *
 *   - src, srcSize: an input buffer for the sequence producer to parse.
 *     srcSize is guaranteed to be <= ZSTD_BLOCKSIZE_MAX.
 *
 *   - dict, dictSize: a history buffer, which may be empty, which the sequence
 *     producer may reference as it parses the src buffer. Currently, zstd will
 *     always pass dictSize == 0 into external sequence producers, but this will
 *     change in the future.
 *
 *   - compressionLevel: a signed integer representing the zstd compression level
 *     set by the user for the current operation. The sequence producer may choose
 *     to use this information to change its compression strategy and speed/ratio
 *     tradeoff. Note: the compression level does not reflect zstd parameters set
 *     through the advanced API.
 *
 *   - windowSize: a size_t representing the maximum allowed offset for external
 *     sequences. Note that sequence offsets are sometimes allowed to exceed the
 *     windowSize if a dictionary is present, see doc/zstd_compression_format.md
 *     for details.
 *
 * The user-provided function shall return a size_t representing the number of
 * sequences written to outSeqs. This return value will be treated as an error
 * code if it is greater than outSeqsCapacity. The return value must be non-zero
 * if srcSize is non-zero. The ZSTD_SEQUENCE_PRODUCER_ERROR macro is provided
 * for convenience, but any value greater than outSeqsCapacity will be treated as
 * an error code.
 *
 * If the user-provided function does not return an error code, the sequences
 * written to outSeqs must be a valid parse of the src buffer. Data corruption may
 * occur if the parse is not valid. A parse is defined to be valid if the
 * following conditions hold:
 *   - The sum of matchLengths and literalLengths must equal srcSize.
 *   - All sequences in the parse, except for the final sequence, must have
 *     matchLength >= ZSTD_MINMATCH_MIN. The final sequence must have
 *     matchLength >= ZSTD_MINMATCH_MIN or matchLength == 0.
 *   - All offsets must respect the windowSize parameter as specified in
 *     doc/zstd_compression_format.md.
 *   - If the final sequence has matchLength == 0, it must also have offset == 0.
 *
 * zstd will only validate these conditions (and fail compression if they do not
 * hold) if the ZSTD_c_validateSequences cParam is enabled. Note that sequence
 * validation has a performance cost.
 *
 * If the user-provided function returns an error, zstd will either fall back
 * to an internal sequence producer or fail the compression operation. The user can
 * choose between the two behaviors by setting the ZSTD_c_enableSeqProducerFallback
 * cParam. Fallback compression will follow any other cParam settings, such as
 * compression level, the same as in a normal compression operation.
 *
 * The user shall instruct zstd to use a particular ZSTD_sequenceProducer_F
 * function by calling
 *         ZSTD_registerSequenceProducer(cctx,
 *                                       sequenceProducerState,
 *                                       sequenceProducer)
 * This setting will persist until the next parameter reset of the CCtx.
 *
 * The sequenceProducerState must be initialized by the user before calling
 * ZSTD_registerSequenceProducer(). The user is responsible for destroying the
 * sequenceProducerState.
 *
 * *** LIMITATIONS ***
 * This API is compatible with all zstd compression APIs which respect advanced parameters.
 * However, there are three limitations:
 *
 * First, the ZSTD_c_enableLongDistanceMatching cParam is not currently supported.
 * COMPRESSION WILL FAIL if it is enabled and the user tries to compress with a block-level
 * external sequence producer.
 *   - Note that ZSTD_c_enableLongDistanceMatching is auto-enabled by default in some
 *     cases (see its documentation for details). Users must explicitly set
 *     ZSTD_c_enableLongDistanceMatching to ZSTD_ps_disable in such cases if an external
 *     sequence producer is registered.
 *   - As of this writing, ZSTD_c_enableLongDistanceMatching is disabled by default
 *     whenever ZSTD_c_windowLog < 128MB, but that's subject to change. Users should
 *     check the docs on ZSTD_c_enableLongDistanceMatching whenever the Block-Level Sequence
 *     Producer API is used in conjunction with advanced settings (like ZSTD_c_windowLog).
 *
 * Second, history buffers are not currently supported. Concretely, zstd will always pass
 * dictSize == 0 to the external sequence producer (for now). This has two implications:
 *   - Dictionaries are not currently supported. Compression will *not* fail if the user
 *     references a dictionary, but the dictionary won't have any effect.
 *   - Stream history is not currently supported. All advanced compression APIs, including
 *     streaming APIs, work with external sequence producers, but each block is treated as
 *     an independent chunk without history from previous blocks.
 *
 * Third, multi-threading within a single compression is not currently supported. In other words,
 * COMPRESSION WILL FAIL if ZSTD_c_nbWorkers > 0 and an external sequence producer is registered.
 * Multi-threading across compressions is fine: simply create one CCtx per thread.
 *
 * Long-term, we plan to overcome all three limitations. There is no technical blocker to
 * overcoming them. It is purely a question of engineering effort.
 */

#define ZSTD_SEQUENCE_PRODUCER_ERROR ((size_t)(-1))

typedef size_t (*ZSTD_sequenceProducer_F) (
  void* sequenceProducerState,
  ZSTD_Sequence* outSeqs, size_t outSeqsCapacity,
  const void* src, size_t srcSize,
  const void* dict, size_t dictSize,
  int compressionLevel,
  size_t windowSize
);

/*! ZSTD_registerSequenceProducer() :
 * Instruct zstd to use a block-level external sequence producer function.
 *
 * The sequenceProducerState must be initialized by the caller, and the caller is
 * responsible for managing its lifetime. This parameter is sticky across
 * compressions. It will remain set until the user explicitly resets compression
 * parameters.
 *
 * Sequence producer registration is considered to be an "advanced parameter",
 * part of the "advanced API". This means it will only have an effect on compression
 * APIs which respect advanced parameters, such as compress2() and compressStream2().
 * Older compression APIs such as compressCCtx(), which predate the introduction of
 * "advanced parameters", will ignore any external sequence producer setting.
 *
 * The sequence producer can be "cleared" by registering a NULL function pointer. This
 * removes all limitations described above in the "LIMITATIONS" section of the API docs.
 *
 * The user is strongly encouraged to read the full API documentation (above) before
 * calling this function. */
ZSTDLIB_STATIC_API void
ZSTD_registerSequenceProducer(
  ZSTD_CCtx* cctx,
  void* sequenceProducerState,
  ZSTD_sequenceProducer_F sequenceProducer
);

/*! ZSTD_CCtxParams_registerSequenceProducer() :
 * Same as ZSTD_registerSequenceProducer(), but operates on ZSTD_CCtx_params.
 * This is used for accurate size estimation with ZSTD_estimateCCtxSize_usingCCtxParams(),
 * which is needed when creating a ZSTD_CCtx with ZSTD_initStaticCCtx().
 *
 * If you are using the external sequence producer API in a scenario where ZSTD_initStaticCCtx()
 * is required, then this function is for you. Otherwise, you probably don't need it.
 *
 * See tests/zstreamtest.c for example usage. */
ZSTDLIB_STATIC_API void
ZSTD_CCtxParams_registerSequenceProducer(
  ZSTD_CCtx_params* params,
  void* sequenceProducerState,
  ZSTD_sequenceProducer_F sequenceProducer
);


/*********************************************************************
*  Buffer-less and synchronous inner streaming functions (DEPRECATED)
*
*  This API is deprecated, and will be removed in a future version.
*  It allows streaming (de)compression with user allocated buffers.
*  However, it is hard to use, and not as well tested as the rest of
*  our API.
*
*  Please use the normal streaming API instead: ZSTD_compressStream2,
*  and ZSTD_decompressStream.
*  If there is functionality that you need, but it doesn't provide,
*  please open an issue on our GitHub.
********************************************************************* */

/**
  Buffer-less streaming compression (synchronous mode)

  A ZSTD_CCtx object is required to track streaming operations.
  Use ZSTD_createCCtx() / ZSTD_freeCCtx() to manage resource.
  ZSTD_CCtx object can be reused multiple times within successive compression operations.

  Start by initializing a context.
  Use ZSTD_compressBegin(), or ZSTD_compressBegin_usingDict() for dictionary compression.

  Then, consume your input using ZSTD_compressContinue().
  There are some important considerations to keep in mind when using this advanced function :
  - ZSTD_compressContinue() has no internal buffer. It uses externally provided buffers only.
  - Interface is synchronous : input is consumed entirely and produces 1+ compressed blocks.
  - Caller must ensure there is enough space in `dst` to store compressed data under worst case scenario.
    Worst case evaluation is provided by ZSTD_compressBound().
    ZSTD_compressContinue() doesn't guarantee recover after a failed compression.
  - ZSTD_compressContinue() presumes prior input ***is still accessible and unmodified*** (up to maximum distance size, see WindowLog).
    It remembers all previous contiguous blocks, plus one separated memory segment (which can itself consists of multiple contiguous blocks)
  - ZSTD_compressContinue() detects that prior input has been overwritten when `src` buffer overlaps.
    In which case, it will "discard" the relevant memory section from its history.

  Finish a frame with ZSTD_compressEnd(), which will write the last block(s) and optional checksum.
  It's possible to use srcSize==0, in which case, it will write a final empty block to end the frame.
  Without last block mark, frames are considered unfinished (hence corrupted) by compliant decoders.

  `ZSTD_CCtx` object can be reused (ZSTD_compressBegin()) to compress again.
*/

/*=====   Buffer-less streaming compression functions  =====*/
ZSTD_DEPRECATED("The buffer-less API is deprecated in favor of the normal streaming API. See docs.")
ZSTDLIB_STATIC_API size_t ZSTD_compressBegin(ZSTD_CCtx* cctx, int compressionLevel);
ZSTD_DEPRECATED("The buffer-less API is deprecated in favor of the normal streaming API. See docs.")
ZSTDLIB_STATIC_API size_t ZSTD_compressBegin_usingDict(ZSTD_CCtx* cctx, const void* dict, size_t dictSize, int compressionLevel);
ZSTD_DEPRECATED("The buffer-less API is deprecated in favor of the normal streaming API. See docs.")
ZSTDLIB_STATIC_API size_t ZSTD_compressBegin_usingCDict(ZSTD_CCtx* cctx, const ZSTD_CDict* cdict); /**< note: fails if cdict==NULL */

ZSTD_DEPRECATED("This function will likely be removed in a future release. It is misleading and has very limited utility.")
ZSTDLIB_STATIC_API
size_t ZSTD_copyCCtx(ZSTD_CCtx* cctx, const ZSTD_CCtx* preparedCCtx, unsigned long long pledgedSrcSize); /**<  note: if pledgedSrcSize is not known, use ZSTD_CONTENTSIZE_UNKNOWN */

ZSTD_DEPRECATED("The buffer-less API is deprecated in favor of the normal streaming API. See docs.")
ZSTDLIB_STATIC_API size_t ZSTD_compressContinue(ZSTD_CCtx* cctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);
ZSTD_DEPRECATED("The buffer-less API is deprecated in favor of the normal streaming API. See docs.")
ZSTDLIB_STATIC_API size_t ZSTD_compressEnd(ZSTD_CCtx* cctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);

/* The ZSTD_compressBegin_advanced() and ZSTD_compressBegin_usingCDict_advanced() are now DEPRECATED and will generate a compiler warning */
ZSTD_DEPRECATED("use advanced API to access custom parameters")
ZSTDLIB_STATIC_API
size_t ZSTD_compressBegin_advanced(ZSTD_CCtx* cctx, const void* dict, size_t dictSize, ZSTD_parameters params, unsigned long long pledgedSrcSize); /**< pledgedSrcSize : If srcSize is not known at init time, use ZSTD_CONTENTSIZE_UNKNOWN */
ZSTD_DEPRECATED("use advanced API to access custom parameters")
ZSTDLIB_STATIC_API
size_t ZSTD_compressBegin_usingCDict_advanced(ZSTD_CCtx* const cctx, const ZSTD_CDict* const cdict, ZSTD_frameParameters const fParams, unsigned long long const pledgedSrcSize);   /* compression parameters are already set within cdict. pledgedSrcSize must be correct. If srcSize is not known, use macro ZSTD_CONTENTSIZE_UNKNOWN */
/**
  Buffer-less streaming decompression (synchronous mode)

  A ZSTD_DCtx object is required to track streaming operations.
  Use ZSTD_createDCtx() / ZSTD_freeDCtx() to manage it.
  A ZSTD_DCtx object can be reused multiple times.

  First typical operation is to retrieve frame parameters, using ZSTD_getFrameHeader().
  Frame header is extracted from the beginning of compressed frame, so providing only the frame's beginning is enough.
  Data fragment must be large enough to ensure successful decoding.
 `ZSTD_frameHeaderSize_max` bytes is guaranteed to always be large enough.
  result  : 0 : successful decoding, the `ZSTD_frameHeader` structure is correctly filled.
           >0 : `srcSize` is too small, please provide at least result bytes on next attempt.
           errorCode, which can be tested using ZSTD_isError().

  It fills a ZSTD_FrameHeader structure with important information to correctly decode the frame,
  such as the dictionary ID, content size, or maximum back-reference distance (`windowSize`).
  Note that these values could be wrong, either because of data corruption, or because a 3rd party deliberately spoofs false information.
  As a consequence, check that values remain within valid application range.
  For example, do not allocate memory blindly, check that `windowSize` is within expectation.
  Each application can set its own limits, depending on local restrictions.
  For extended interoperability, it is recommended to support `windowSize` of at least 8 MB.

  ZSTD_decompressContinue() needs previous data blocks during decompression, up to `windowSize` bytes.
  ZSTD_decompressContinue() is very sensitive to contiguity,
  if 2 blocks don't follow each other, make sure that either the compressor breaks contiguity at the same place,
  or that previous contiguous segment is large enough to properly handle maximum back-reference distance.
  There are multiple ways to guarantee this condition.

  The most memory efficient way is to use a round buffer of sufficient size.
  Sufficient size is determined by invoking ZSTD_decodingBufferSize_min(),
  which can return an error code if required value is too large for current system (in 32-bits mode).
  In a round buffer methodology, ZSTD_decompressContinue() decompresses each block next to previous one,
  up to the moment there is not enough room left in the buffer to guarantee decoding another full block,
  which maximum size is provided in `ZSTD_frameHeader` structure, field `blockSizeMax`.
  At which point, decoding can resume from the beginning of the buffer.
  Note that already decoded data stored in the buffer should be flushed before being overwritten.

  There are alternatives possible, for example using two or more buffers of size `windowSize` each, though they consume more memory.

  Finally, if you control the compression process, you can also ignore all buffer size rules,
  as long as the encoder and decoder progress in "lock-step",
  aka use exactly the same buffer sizes, break contiguity at the same place, etc.

  Once buffers are setup, start decompression, with ZSTD_decompressBegin().
  If decompression requires a dictionary, use ZSTD_decompressBegin_usingDict() or ZSTD_decompressBegin_usingDDict().

  Then use ZSTD_nextSrcSizeToDecompress() and ZSTD_decompressContinue() alternatively.
  ZSTD_nextSrcSizeToDecompress() tells how many bytes to provide as 'srcSize' to ZSTD_decompressContinue().
  ZSTD_decompressContinue() requires this _exact_ amount of bytes, or it will fail.

  result of ZSTD_decompressContinue() is the number of bytes regenerated within 'dst' (necessarily <= dstCapacity).
  It can be zero : it just means ZSTD_decompressContinue() has decoded some metadata item.
  It can also be an error code, which can be tested with ZSTD_isError().

  A frame is fully decoded when ZSTD_nextSrcSizeToDecompress() returns zero.
  Context can then be reset to start a new decompression.

  Note : it's possible to know if next input to present is a header or a block, using ZSTD_nextInputType().
  This information is not required to properly decode a frame.

  == Special case : skippable frames ==

  Skippable frames allow integration of user-defined data into a flow of concatenated frames.
  Skippable frames will be ignored (skipped) by decompressor.
  The format of skippable frames is as follows :
  a) Skippable frame ID - 4 Bytes, Little endian format, any value from 0x184D2A50 to 0x184D2A5F
  b) Frame Size - 4 Bytes, Little endian format, unsigned 32-bits
  c) Frame Content - any content (User Data) of length equal to Frame Size
  For skippable frames ZSTD_getFrameHeader() returns zfhPtr->frameType==ZSTD_skippableFrame.
  For skippable frames ZSTD_decompressContinue() always returns 0 : it only skips the content.
*/

/*=====   Buffer-less streaming decompression functions  =====*/

ZSTDLIB_STATIC_API size_t ZSTD_decodingBufferSize_min(unsigned long long windowSize, unsigned long long frameContentSize);  /**< when frame content size is not known, pass in frameContentSize == ZSTD_CONTENTSIZE_UNKNOWN */

ZSTDLIB_STATIC_API size_t ZSTD_decompressBegin(ZSTD_DCtx* dctx);
ZSTDLIB_STATIC_API size_t ZSTD_decompressBegin_usingDict(ZSTD_DCtx* dctx, const void* dict, size_t dictSize);
ZSTDLIB_STATIC_API size_t ZSTD_decompressBegin_usingDDict(ZSTD_DCtx* dctx, const ZSTD_DDict* ddict);

ZSTDLIB_STATIC_API size_t ZSTD_nextSrcSizeToDecompress(ZSTD_DCtx* dctx);
ZSTDLIB_STATIC_API size_t ZSTD_decompressContinue(ZSTD_DCtx* dctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);

/* misc */
ZSTD_DEPRECATED("This function will likely be removed in the next minor release. It is misleading and has very limited utility.")
ZSTDLIB_STATIC_API void   ZSTD_copyDCtx(ZSTD_DCtx* dctx, const ZSTD_DCtx* preparedDCtx);
typedef enum { ZSTDnit_frameHeader, ZSTDnit_blockHeader, ZSTDnit_block, ZSTDnit_lastBlock, ZSTDnit_checksum, ZSTDnit_skippableFrame } ZSTD_nextInputType_e;
ZSTDLIB_STATIC_API ZSTD_nextInputType_e ZSTD_nextInputType(ZSTD_DCtx* dctx);




/* ========================================= */
/**       Block level API (DEPRECATED)       */
/* ========================================= */

/*!

    This API is deprecated in favor of the regular compression API.
    You can get the frame header down to 2 bytes by setting:
      - ZSTD_c_format = ZSTD_f_zstd1_magicless
      - ZSTD_c_contentSizeFlag = 0
      - ZSTD_c_checksumFlag = 0
      - ZSTD_c_dictIDFlag = 0

    This API is not as well tested as our normal API, so we recommend not using it.
    We will be removing it in a future version. If the normal API doesn't provide
    the functionality you need, please open a GitHub issue.

    Block functions produce and decode raw zstd blocks, without frame metadata.
    Frame metadata cost is typically ~12 bytes, which can be non-negligible for very small blocks (< 100 bytes).
    But users will have to take in charge needed metadata to regenerate data, such as compressed and content sizes.

    A few rules to respect :
    - Compressing and decompressing require a context structure
      + Use ZSTD_createCCtx() and ZSTD_createDCtx()
    - It is necessary to init context before starting
      + compression : any ZSTD_compressBegin*() variant, including with dictionary
      + decompression : any ZSTD_decompressBegin*() variant, including with dictionary
    - Block size is limited, it must be <= ZSTD_getBlockSize() <= ZSTD_BLOCKSIZE_MAX == 128 KB
      + If input is larger than a block size, it's necessary to split input data into multiple blocks
      + For inputs larger than a single block, consider using regular ZSTD_compress() instead.
        Frame metadata is not that costly, and quickly becomes negligible as source size grows larger than a block.
    - When a block is considered not compressible enough, ZSTD_compressBlock() result will be 0 (zero) !
      ===> In which case, nothing is produced into `dst` !
      + User __must__ test for such outcome and deal directly with uncompressed data
      + A block cannot be declared incompressible if ZSTD_compressBlock() return value was != 0.
        Doing so would mess up with statistics history, leading to potential data corruption.
      + ZSTD_decompressBlock() _doesn't accept uncompressed data as input_ !!
      + In case of multiple successive blocks, should some of them be uncompressed,
        decoder must be informed of their existence in order to follow proper history.
        Use ZSTD_insertBlock() for such a case.
*/

/*=====   Raw zstd block functions  =====*/
ZSTD_DEPRECATED("The block API is deprecated in favor of the normal compression API. See docs.")
ZSTDLIB_STATIC_API size_t ZSTD_getBlockSize   (const ZSTD_CCtx* cctx);
ZSTD_DEPRECATED("The block API is deprecated in favor of the normal compression API. See docs.")
ZSTDLIB_STATIC_API size_t ZSTD_compressBlock  (ZSTD_CCtx* cctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);
ZSTD_DEPRECATED("The block API is deprecated in favor of the normal compression API. See docs.")
ZSTDLIB_STATIC_API size_t ZSTD_decompressBlock(ZSTD_DCtx* dctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);
ZSTD_DEPRECATED("The block API is deprecated in favor of the normal compression API. See docs.")
ZSTDLIB_STATIC_API size_t ZSTD_insertBlock    (ZSTD_DCtx* dctx, const void* blockStart, size_t blockSize);  /**< insert uncompressed block into `dctx` history. Useful for multi-blocks decompression. */

#if defined (__cplusplus)
}
#endif

#endif   /* ZSTD_H_ZSTD_STATIC_LINKING_ONLY */
