/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_ZDICT_H
#define ZSTD_ZDICT_H


/*======  Dependencies  ======*/
#include <stddef.h>  /* size_t */

#if defined (__cplusplus)
extern "C" {
#endif

/* =====   ZDICTLIB_API : control library symbols visibility   ===== */
#ifndef ZDICTLIB_VISIBLE
   /* Backwards compatibility with old macro name */
#  ifdef ZDICTLIB_VISIBILITY
#    define ZDICTLIB_VISIBLE ZDICTLIB_VISIBILITY
#  elif defined(__GNUC__) && (__GNUC__ >= 4) && !defined(__MINGW32__)
#    define ZDICTLIB_VISIBLE __attribute__ ((visibility ("default")))
#  else
#    define ZDICTLIB_VISIBLE
#  endif
#endif

#ifndef ZDICTLIB_HIDDEN
#  if defined(__GNUC__) && (__GNUC__ >= 4) && !defined(__MINGW32__)
#    define ZDICTLIB_HIDDEN __attribute__ ((visibility ("hidden")))
#  else
#    define ZDICTLIB_HIDDEN
#  endif
#endif

#if defined(ZSTD_DLL_EXPORT) && (ZSTD_DLL_EXPORT==1)
#  define ZDICTLIB_API __declspec(dllexport) ZDICTLIB_VISIBLE
#elif defined(ZSTD_DLL_IMPORT) && (ZSTD_DLL_IMPORT==1)
#  define ZDICTLIB_API __declspec(dllimport) ZDICTLIB_VISIBLE /* It isn't required but allows to generate better code, saving a function pointer load from the IAT and an indirect jump.*/
#else
#  define ZDICTLIB_API ZDICTLIB_VISIBLE
#endif

/*******************************************************************************
 * Zstd dictionary builder
 *
 * FAQ
 * ===
 * Why should I use a dictionary?
 * ------------------------------
 *
 * Zstd can use dictionaries to improve compression ratio of small data.
 * Traditionally small files don't compress well because there is very little
 * repetition in a single sample, since it is small. But, if you are compressing
 * many similar files, like a bunch of JSON records that share the same
 * structure, you can train a dictionary on ahead of time on some samples of
 * these files. Then, zstd can use the dictionary to find repetitions that are
 * present across samples. This can vastly improve compression ratio.
 *
 * When is a dictionary useful?
 * ----------------------------
 *
 * Dictionaries are useful when compressing many small files that are similar.
 * The larger a file is, the less benefit a dictionary will have. Generally,
 * we don't expect dictionary compression to be effective past 100KB. And the
 * smaller a file is, the more we would expect the dictionary to help.
 *
 * How do I use a dictionary?
 * --------------------------
 *
 * Simply pass the dictionary to the zstd compressor with
 * `ZSTD_CCtx_loadDictionary()`. The same dictionary must then be passed to
 * the decompressor, using `ZSTD_DCtx_loadDictionary()`. There are other
 * more advanced functions that allow selecting some options, see zstd.h for
 * complete documentation.
 *
 * What is a zstd dictionary?
 * --------------------------
 *
 * A zstd dictionary has two pieces: Its header, and its content. The header
 * contains a magic number, the dictionary ID, and entropy tables. These
 * entropy tables allow zstd to save on header costs in the compressed file,
 * which really matters for small data. The content is just bytes, which are
 * repeated content that is common across many samples.
 *
 * What is a raw content dictionary?
 * ---------------------------------
 *
 * A raw content dictionary is just bytes. It doesn't have a zstd dictionary
 * header, a dictionary ID, or entropy tables. Any buffer is a valid raw
 * content dictionary.
 *
 * How do I train a dictionary?
 * ----------------------------
 *
 * Gather samples from your use case. These samples should be similar to each
 * other. If you have several use cases, you could try to train one dictionary
 * per use case.
 *
 * Pass those samples to `ZDICT_trainFromBuffer()` and that will train your
 * dictionary. There are a few advanced versions of this function, but this
 * is a great starting point. If you want to further tune your dictionary
 * you could try `ZDICT_optimizeTrainFromBuffer_cover()`. If that is too slow
 * you can try `ZDICT_optimizeTrainFromBuffer_fastCover()`.
 *
 * If the dictionary training function fails, that is likely because you
 * either passed too few samples, or a dictionary would not be effective
 * for your data. Look at the messages that the dictionary trainer printed,
 * if it doesn't say too few samples, then a dictionary would not be effective.
 *
 * How large should my dictionary be?
 * ----------------------------------
 *
 * A reasonable dictionary size, the `dictBufferCapacity`, is about 100KB.
 * The zstd CLI defaults to a 110KB dictionary. You likely don't need a
 * dictionary larger than that. But, most use cases can get away with a
 * smaller dictionary. The advanced dictionary builders can automatically
 * shrink the dictionary for you, and select the smallest size that doesn't
 * hurt compression ratio too much. See the `shrinkDict` parameter.
 * A smaller dictionary can save memory, and potentially speed up
 * compression.
 *
 * How many samples should I provide to the dictionary builder?
 * ------------------------------------------------------------
 *
 * We generally recommend passing ~100x the size of the dictionary
 * in samples. A few thousand should suffice. Having too few samples
 * can hurt the dictionaries effectiveness. Having more samples will
 * only improve the dictionaries effectiveness. But having too many
 * samples can slow down the dictionary builder.
 *
 * How do I determine if a dictionary will be effective?
 * -----------------------------------------------------
 *
 * Simply train a dictionary and try it out. You can use zstd's built in
 * benchmarking tool to test the dictionary effectiveness.
 *
 *   # Benchmark levels 1-3 without a dictionary
 *   zstd -b1e3 -r /path/to/my/files
 *   # Benchmark levels 1-3 with a dictionary
 *   zstd -b1e3 -r /path/to/my/files -D /path/to/my/dictionary
 *
 * When should I retrain a dictionary?
 * -----------------------------------
 *
 * You should retrain a dictionary when its effectiveness drops. Dictionary
 * effectiveness drops as the data you are compressing changes. Generally, we do
 * expect dictionaries to "decay" over time, as your data changes, but the rate
 * at which they decay depends on your use case. Internally, we regularly
 * retrain dictionaries, and if the new dictionary performs significantly
 * better than the old dictionary, we will ship the new dictionary.
 *
 * I have a raw content dictionary, how do I turn it into a zstd dictionary?
 * -------------------------------------------------------------------------
 *
 * If you have a raw content dictionary, e.g. by manually constructing it, or
 * using a third-party dictionary builder, you can turn it into a zstd
 * dictionary by using `ZDICT_finalizeDictionary()`. You'll also have to
 * provide some samples of the data. It will add the zstd header to the
 * raw content, which contains a dictionary ID and entropy tables, which
 * will improve compression ratio, and allow zstd to write the dictionary ID
 * into the frame, if you so choose.
 *
 * Do I have to use zstd's dictionary builder?
 * -------------------------------------------
 *
 * No! You can construct dictionary content however you please, it is just
 * bytes. It will always be valid as a raw content dictionary. If you want
 * a zstd dictionary, which can improve compression ratio, use
 * `ZDICT_finalizeDictionary()`.
 *
 * What is the attack surface of a zstd dictionary?
 * ------------------------------------------------
 *
 * Zstd is heavily fuzz tested, including loading fuzzed dictionaries, so
 * zstd should never crash, or access out-of-bounds memory no matter what
 * the dictionary is. However, if an attacker can control the dictionary
 * during decompression, they can cause zstd to generate arbitrary bytes,
 * just like if they controlled the compressed data.
 *
 ******************************************************************************/


/*! ZDICT_trainFromBuffer():
 *  Train a dictionary from an array of samples.
 *  Redirect towards ZDICT_optimizeTrainFromBuffer_fastCover() single-threaded, with d=8, steps=4,
 *  f=20, and accel=1.
 *  Samples must be stored concatenated in a single flat buffer `samplesBuffer`,
 *  supplied with an array of sizes `samplesSizes`, providing the size of each sample, in order.
 *  The resulting dictionary will be saved into `dictBuffer`.
 * @return: size of dictionary stored into `dictBuffer` (<= `dictBufferCapacity`)
 *          or an error code, which can be tested with ZDICT_isError().
 *  Note:  Dictionary training will fail if there are not enough samples to construct a
 *         dictionary, or if most of the samples are too small (< 8 bytes being the lower limit).
 *         If dictionary training fails, you should use zstd without a dictionary, as the dictionary
 *         would've been ineffective anyways. If you believe your samples would benefit from a dictionary
 *         please open an issue with details, and we can look into it.
 *  Note: ZDICT_trainFromBuffer()'s memory usage is about 6 MB.
 *  Tips: In general, a reasonable dictionary has a size of ~ 100 KB.
 *        It's possible to select smaller or larger size, just by specifying `dictBufferCapacity`.
 *        In general, it's recommended to provide a few thousands samples, though this can vary a lot.
 *        It's recommended that total size of all samples be about ~x100 times the target size of dictionary.
 */
ZDICTLIB_API size_t ZDICT_trainFromBuffer(void* dictBuffer, size_t dictBufferCapacity,
                                    const void* samplesBuffer,
                                    const size_t* samplesSizes, unsigned nbSamples);

typedef struct {
    int      compressionLevel;   /**< optimize for a specific zstd compression level; 0 means default */
    unsigned notificationLevel;  /**< Write log to stderr; 0 = none (default); 1 = errors; 2 = progression; 3 = details; 4 = debug; */
    unsigned dictID;             /**< force dictID value; 0 means auto mode (32-bits random value)
                                  *   NOTE: The zstd format reserves some dictionary IDs for future use.
                                  *         You may use them in private settings, but be warned that they
                                  *         may be used by zstd in a public dictionary registry in the future.
                                  *         These dictionary IDs are:
                                  *           - low range  : <= 32767
                                  *           - high range : >= (2^31)
                                  */
} ZDICT_params_t;

/*! ZDICT_finalizeDictionary():
 * Given a custom content as a basis for dictionary, and a set of samples,
 * finalize dictionary by adding headers and statistics according to the zstd
 * dictionary format.
 *
 * Samples must be stored concatenated in a flat buffer `samplesBuffer`,
 * supplied with an array of sizes `samplesSizes`, providing the size of each
 * sample in order. The samples are used to construct the statistics, so they
 * should be representative of what you will compress with this dictionary.
 *
 * The compression level can be set in `parameters`. You should pass the
 * compression level you expect to use in production. The statistics for each
 * compression level differ, so tuning the dictionary for the compression level
 * can help quite a bit.
 *
 * You can set an explicit dictionary ID in `parameters`, or allow us to pick
 * a random dictionary ID for you, but we can't guarantee no collisions.
 *
 * The dstDictBuffer and the dictContent may overlap, and the content will be
 * appended to the end of the header. If the header + the content doesn't fit in
 * maxDictSize the beginning of the content is truncated to make room, since it
 * is presumed that the most profitable content is at the end of the dictionary,
 * since that is the cheapest to reference.
 *
 * `maxDictSize` must be >= max(dictContentSize, ZDICT_DICTSIZE_MIN).
 *
 * @return: size of dictionary stored into `dstDictBuffer` (<= `maxDictSize`),
 *          or an error code, which can be tested by ZDICT_isError().
 * Note: ZDICT_finalizeDictionary() will push notifications into stderr if
 *       instructed to, using notificationLevel>0.
 * NOTE: This function currently may fail in several edge cases including:
 *         * Not enough samples
 *         * Samples are uncompressible
 *         * Samples are all exactly the same
 */
ZDICTLIB_API size_t ZDICT_finalizeDictionary(void* dstDictBuffer, size_t maxDictSize,
                                const void* dictContent, size_t dictContentSize,
                                const void* samplesBuffer, const size_t* samplesSizes, unsigned nbSamples,
                                ZDICT_params_t parameters);


/*======   Helper functions   ======*/
ZDICTLIB_API unsigned ZDICT_getDictID(const void* dictBuffer, size_t dictSize);  /**< extracts dictID; @return zero if error (not a valid dictionary) */
ZDICTLIB_API size_t ZDICT_getDictHeaderSize(const void* dictBuffer, size_t dictSize);  /* returns dict header size; returns a ZSTD error code on failure */
ZDICTLIB_API unsigned ZDICT_isError(size_t errorCode);
ZDICTLIB_API const char* ZDICT_getErrorName(size_t errorCode);

#if defined (__cplusplus)
}
#endif

#endif   /* ZSTD_ZDICT_H */

#if defined(ZDICT_STATIC_LINKING_ONLY) && !defined(ZSTD_ZDICT_H_STATIC)
#define ZSTD_ZDICT_H_STATIC

#if defined (__cplusplus)
extern "C" {
#endif

/* This can be overridden externally to hide static symbols. */
#ifndef ZDICTLIB_STATIC_API
#  if defined(ZSTD_DLL_EXPORT) && (ZSTD_DLL_EXPORT==1)
#    define ZDICTLIB_STATIC_API __declspec(dllexport) ZDICTLIB_VISIBLE
#  elif defined(ZSTD_DLL_IMPORT) && (ZSTD_DLL_IMPORT==1)
#    define ZDICTLIB_STATIC_API __declspec(dllimport) ZDICTLIB_VISIBLE
#  else
#    define ZDICTLIB_STATIC_API ZDICTLIB_VISIBLE
#  endif
#endif

/* ====================================================================================
 * The definitions in this section are considered experimental.
 * They should never be used with a dynamic library, as they may change in the future.
 * They are provided for advanced usages.
 * Use them only in association with static linking.
 * ==================================================================================== */

#define ZDICT_DICTSIZE_MIN    256
/* Deprecated: Remove in v1.6.0 */
#define ZDICT_CONTENTSIZE_MIN 128

/*! ZDICT_cover_params_t:
 *  k and d are the only required parameters.
 *  For others, value 0 means default.
 */
typedef struct {
    unsigned k;                  /* Segment size : constraint: 0 < k : Reasonable range [16, 2048+] */
    unsigned d;                  /* dmer size : constraint: 0 < d <= k : Reasonable range [6, 16] */
    unsigned steps;              /* Number of steps : Only used for optimization : 0 means default (40) : Higher means more parameters checked */
    unsigned nbThreads;          /* Number of threads : constraint: 0 < nbThreads : 1 means single-threaded : Only used for optimization : Ignored if ZSTD_MULTITHREAD is not defined */
    double splitPoint;           /* Percentage of samples used for training: Only used for optimization : the first nbSamples * splitPoint samples will be used to training, the last nbSamples * (1 - splitPoint) samples will be used for testing, 0 means default (1.0), 1.0 when all samples are used for both training and testing */
    unsigned shrinkDict;         /* Train dictionaries to shrink in size starting from the minimum size and selects the smallest dictionary that is shrinkDictMaxRegression% worse than the largest dictionary. 0 means no shrinking and 1 means shrinking  */
    unsigned shrinkDictMaxRegression; /* Sets shrinkDictMaxRegression so that a smaller dictionary can be at worse shrinkDictMaxRegression% worse than the max dict size dictionary. */
    ZDICT_params_t zParams;
} ZDICT_cover_params_t;

typedef struct {
    unsigned k;                  /* Segment size : constraint: 0 < k : Reasonable range [16, 2048+] */
    unsigned d;                  /* dmer size : constraint: 0 < d <= k : Reasonable range [6, 16] */
    unsigned f;                  /* log of size of frequency array : constraint: 0 < f <= 31 : 1 means default(20)*/
    unsigned steps;              /* Number of steps : Only used for optimization : 0 means default (40) : Higher means more parameters checked */
    unsigned nbThreads;          /* Number of threads : constraint: 0 < nbThreads : 1 means single-threaded : Only used for optimization : Ignored if ZSTD_MULTITHREAD is not defined */
    double splitPoint;           /* Percentage of samples used for training: Only used for optimization : the first nbSamples * splitPoint samples will be used to training, the last nbSamples * (1 - splitPoint) samples will be used for testing, 0 means default (0.75), 1.0 when all samples are used for both training and testing */
    unsigned accel;              /* Acceleration level: constraint: 0 < accel <= 10, higher means faster and less accurate, 0 means default(1) */
    unsigned shrinkDict;         /* Train dictionaries to shrink in size starting from the minimum size and selects the smallest dictionary that is shrinkDictMaxRegression% worse than the largest dictionary. 0 means no shrinking and 1 means shrinking  */
    unsigned shrinkDictMaxRegression; /* Sets shrinkDictMaxRegression so that a smaller dictionary can be at worse shrinkDictMaxRegression% worse than the max dict size dictionary. */

    ZDICT_params_t zParams;
} ZDICT_fastCover_params_t;

/*! ZDICT_trainFromBuffer_cover():
 *  Train a dictionary from an array of samples using the COVER algorithm.
 *  Samples must be stored concatenated in a single flat buffer `samplesBuffer`,
 *  supplied with an array of sizes `samplesSizes`, providing the size of each sample, in order.
 *  The resulting dictionary will be saved into `dictBuffer`.
 * @return: size of dictionary stored into `dictBuffer` (<= `dictBufferCapacity`)
 *          or an error code, which can be tested with ZDICT_isError().
 *          See ZDICT_trainFromBuffer() for details on failure modes.
 *  Note: ZDICT_trainFromBuffer_cover() requires about 9 bytes of memory for each input byte.
 *  Tips: In general, a reasonable dictionary has a size of ~ 100 KB.
 *        It's possible to select smaller or larger size, just by specifying `dictBufferCapacity`.
 *        In general, it's recommended to provide a few thousands samples, though this can vary a lot.
 *        It's recommended that total size of all samples be about ~x100 times the target size of dictionary.
 */
ZDICTLIB_STATIC_API size_t ZDICT_trainFromBuffer_cover(
          void *dictBuffer, size_t dictBufferCapacity,
    const void *samplesBuffer, const size_t *samplesSizes, unsigned nbSamples,
          ZDICT_cover_params_t parameters);

/*! ZDICT_optimizeTrainFromBuffer_cover():
 * The same requirements as above hold for all the parameters except `parameters`.
 * This function tries many parameter combinations and picks the best parameters.
 * `*parameters` is filled with the best parameters found,
 * dictionary constructed with those parameters is stored in `dictBuffer`.
 *
 * All of the parameters d, k, steps are optional.
 * If d is non-zero then we don't check multiple values of d, otherwise we check d = {6, 8}.
 * if steps is zero it defaults to its default value.
 * If k is non-zero then we don't check multiple values of k, otherwise we check steps values in [50, 2000].
 *
 * @return: size of dictionary stored into `dictBuffer` (<= `dictBufferCapacity`)
 *          or an error code, which can be tested with ZDICT_isError().
 *          On success `*parameters` contains the parameters selected.
 *          See ZDICT_trainFromBuffer() for details on failure modes.
 * Note: ZDICT_optimizeTrainFromBuffer_cover() requires about 8 bytes of memory for each input byte and additionally another 5 bytes of memory for each byte of memory for each thread.
 */
ZDICTLIB_STATIC_API size_t ZDICT_optimizeTrainFromBuffer_cover(
          void* dictBuffer, size_t dictBufferCapacity,
    const void* samplesBuffer, const size_t* samplesSizes, unsigned nbSamples,
          ZDICT_cover_params_t* parameters);

/*! ZDICT_trainFromBuffer_fastCover():
 *  Train a dictionary from an array of samples using a modified version of COVER algorithm.
 *  Samples must be stored concatenated in a single flat buffer `samplesBuffer`,
 *  supplied with an array of sizes `samplesSizes`, providing the size of each sample, in order.
 *  d and k are required.
 *  All other parameters are optional, will use default values if not provided
 *  The resulting dictionary will be saved into `dictBuffer`.
 * @return: size of dictionary stored into `dictBuffer` (<= `dictBufferCapacity`)
 *          or an error code, which can be tested with ZDICT_isError().
 *          See ZDICT_trainFromBuffer() for details on failure modes.
 *  Note: ZDICT_trainFromBuffer_fastCover() requires 6 * 2^f bytes of memory.
 *  Tips: In general, a reasonable dictionary has a size of ~ 100 KB.
 *        It's possible to select smaller or larger size, just by specifying `dictBufferCapacity`.
 *        In general, it's recommended to provide a few thousands samples, though this can vary a lot.
 *        It's recommended that total size of all samples be about ~x100 times the target size of dictionary.
 */
ZDICTLIB_STATIC_API size_t ZDICT_trainFromBuffer_fastCover(void *dictBuffer,
                    size_t dictBufferCapacity, const void *samplesBuffer,
                    const size_t *samplesSizes, unsigned nbSamples,
                    ZDICT_fastCover_params_t parameters);

/*! ZDICT_optimizeTrainFromBuffer_fastCover():
 * The same requirements as above hold for all the parameters except `parameters`.
 * This function tries many parameter combinations (specifically, k and d combinations)
 * and picks the best parameters. `*parameters` is filled with the best parameters found,
 * dictionary constructed with those parameters is stored in `dictBuffer`.
 * All of the parameters d, k, steps, f, and accel are optional.
 * If d is non-zero then we don't check multiple values of d, otherwise we check d = {6, 8}.
 * if steps is zero it defaults to its default value.
 * If k is non-zero then we don't check multiple values of k, otherwise we check steps values in [50, 2000].
 * If f is zero, default value of 20 is used.
 * If accel is zero, default value of 1 is used.
 *
 * @return: size of dictionary stored into `dictBuffer` (<= `dictBufferCapacity`)
 *          or an error code, which can be tested with ZDICT_isError().
 *          On success `*parameters` contains the parameters selected.
 *          See ZDICT_trainFromBuffer() for details on failure modes.
 * Note: ZDICT_optimizeTrainFromBuffer_fastCover() requires about 6 * 2^f bytes of memory for each thread.
 */
ZDICTLIB_STATIC_API size_t ZDICT_optimizeTrainFromBuffer_fastCover(void* dictBuffer,
                    size_t dictBufferCapacity, const void* samplesBuffer,
                    const size_t* samplesSizes, unsigned nbSamples,
                    ZDICT_fastCover_params_t* parameters);

typedef struct {
    unsigned selectivityLevel;   /* 0 means default; larger => select more => larger dictionary */
    ZDICT_params_t zParams;
} ZDICT_legacy_params_t;

/*! ZDICT_trainFromBuffer_legacy():
 *  Train a dictionary from an array of samples.
 *  Samples must be stored concatenated in a single flat buffer `samplesBuffer`,
 *  supplied with an array of sizes `samplesSizes`, providing the size of each sample, in order.
 *  The resulting dictionary will be saved into `dictBuffer`.
 * `parameters` is optional and can be provided with values set to 0 to mean "default".
 * @return: size of dictionary stored into `dictBuffer` (<= `dictBufferCapacity`)
 *          or an error code, which can be tested with ZDICT_isError().
 *          See ZDICT_trainFromBuffer() for details on failure modes.
 *  Tips: In general, a reasonable dictionary has a size of ~ 100 KB.
 *        It's possible to select smaller or larger size, just by specifying `dictBufferCapacity`.
 *        In general, it's recommended to provide a few thousands samples, though this can vary a lot.
 *        It's recommended that total size of all samples be about ~x100 times the target size of dictionary.
 *  Note: ZDICT_trainFromBuffer_legacy() will send notifications into stderr if instructed to, using notificationLevel>0.
 */
ZDICTLIB_STATIC_API size_t ZDICT_trainFromBuffer_legacy(
    void* dictBuffer, size_t dictBufferCapacity,
    const void* samplesBuffer, const size_t* samplesSizes, unsigned nbSamples,
    ZDICT_legacy_params_t parameters);


/* Deprecation warnings */
/* It is generally possible to disable deprecation warnings from compiler,
   for example with -Wno-deprecated-declarations for gcc
   or _CRT_SECURE_NO_WARNINGS in Visual.
   Otherwise, it's also possible to manually define ZDICT_DISABLE_DEPRECATE_WARNINGS */
#ifdef ZDICT_DISABLE_DEPRECATE_WARNINGS
#  define ZDICT_DEPRECATED(message) /* disable deprecation warnings */
#else
#  define ZDICT_GCC_VERSION (__GNUC__ * 100 + __GNUC_MINOR__)
#  if defined (__cplusplus) && (__cplusplus >= 201402) /* C++14 or greater */
#    define ZDICT_DEPRECATED(message) [[deprecated(message)]]
#  elif defined(__clang__) || (ZDICT_GCC_VERSION >= 405)
#    define ZDICT_DEPRECATED(message) __attribute__((deprecated(message)))
#  elif (ZDICT_GCC_VERSION >= 301)
#    define ZDICT_DEPRECATED(message) __attribute__((deprecated))
#  elif defined(_MSC_VER)
#    define ZDICT_DEPRECATED(message) __declspec(deprecated(message))
#  else
#    pragma message("WARNING: You need to implement ZDICT_DEPRECATED for this compiler")
#    define ZDICT_DEPRECATED(message)
#  endif
#endif /* ZDICT_DISABLE_DEPRECATE_WARNINGS */

ZDICT_DEPRECATED("use ZDICT_finalizeDictionary() instead")
ZDICTLIB_STATIC_API
size_t ZDICT_addEntropyTablesFromBuffer(void* dictBuffer, size_t dictContentSize, size_t dictBufferCapacity,
                                  const void* samplesBuffer, const size_t* samplesSizes, unsigned nbSamples);

#if defined (__cplusplus)
}
#endif

#endif   /* ZSTD_ZDICT_H_STATIC */
