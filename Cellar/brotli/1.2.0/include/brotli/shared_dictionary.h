/* Copyright 2017 Google Inc. All Rights Reserved.

   Distributed under MIT license.
   See file LICENSE for detail or copy at https://opensource.org/licenses/MIT
*/

/* (Opaque) Shared Dictionary definition and utilities. */

#ifndef BROTLI_COMMON_SHARED_DICTIONARY_H_
#define BROTLI_COMMON_SHARED_DICTIONARY_H_

#include <brotli/port.h>
#include <brotli/types.h>

#if defined(__cplusplus) || defined(c_plusplus)
extern "C" {
#endif

#define SHARED_BROTLI_MIN_DICTIONARY_WORD_LENGTH 4
#define SHARED_BROTLI_MAX_DICTIONARY_WORD_LENGTH 31
#define SHARED_BROTLI_NUM_DICTIONARY_CONTEXTS 64
#define SHARED_BROTLI_MAX_COMPOUND_DICTS 15

/**
 * Opaque structure that holds shared dictionary data.
 *
 * Allocated and initialized with ::BrotliSharedDictionaryCreateInstance.
 * Cleaned up and deallocated with ::BrotliSharedDictionaryDestroyInstance.
 */
typedef struct BrotliSharedDictionaryStruct BrotliSharedDictionary;

/**
 * Input data type for ::BrotliSharedDictionaryAttach.
 */
typedef enum BrotliSharedDictionaryType {
  /** Raw LZ77 prefix dictionary. */
  BROTLI_SHARED_DICTIONARY_RAW = 0,
  /** Serialized shared dictionary.
   *
   * DO NOT USE: methods accepting this value will fail.
   */
  BROTLI_SHARED_DICTIONARY_SERIALIZED = 1
} BrotliSharedDictionaryType;

/**
 * Creates an instance of ::BrotliSharedDictionary.
 *
 * Fresh instance has default word dictionary and transforms
 * and no LZ77 prefix dictionary.
 *
 * @p alloc_func and @p free_func @b MUST be both zero or both non-zero. In the
 * case they are both zero, default memory allocators are used. @p opaque is
 * passed to @p alloc_func and @p free_func when they are called. @p free_func
 * has to return without doing anything when asked to free a NULL pointer.
 *
 * @param alloc_func custom memory allocation function
 * @param free_func custom memory free function
 * @param opaque custom memory manager handle
 * @returns @c 0 if instance can not be allocated or initialized
 * @returns pointer to initialized ::BrotliSharedDictionary otherwise
 */
BROTLI_COMMON_API BrotliSharedDictionary* BrotliSharedDictionaryCreateInstance(
    brotli_alloc_func alloc_func, brotli_free_func free_func, void* opaque);

/**
 * Deinitializes and frees ::BrotliSharedDictionary instance.
 *
 * @param dict shared dictionary instance to be cleaned up and deallocated
 */
BROTLI_COMMON_API void BrotliSharedDictionaryDestroyInstance(
    BrotliSharedDictionary* dict);

/**
 * Attaches dictionary to a given instance of ::BrotliSharedDictionary.
 *
 * Dictionary to be attached is represented in a serialized format as a region
 * of memory.
 *
 * Provided data it partially referenced by a resulting (compound) dictionary,
 * and should be kept untouched, while at least one compound dictionary uses it.
 * This way memory overhead is kept minimal by the cost of additional resource
 * management.
 *
 * @param dict dictionary to extend
 * @param type type of dictionary to attach
 * @param data_size size of @p data
 * @param data serialized dictionary of type @p type, with at least @p data_size
 *        addressable bytes
 * @returns ::BROTLI_TRUE if provided dictionary is successfully attached
 * @returns ::BROTLI_FALSE otherwise
 */
BROTLI_COMMON_API BROTLI_BOOL BrotliSharedDictionaryAttach(
    BrotliSharedDictionary* dict, BrotliSharedDictionaryType type,
    size_t data_size, const uint8_t data[BROTLI_ARRAY_PARAM(data_size)]);

#if defined(__cplusplus) || defined(c_plusplus)
}  /* extern "C" */
#endif

#endif  /* BROTLI_COMMON_SHARED_DICTIONARY_H_ */
