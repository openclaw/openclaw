/* Copyright 2013 Google Inc. All Rights Reserved.

   Distributed under MIT license.
   See file LICENSE for detail or copy at https://opensource.org/licenses/MIT
*/

/**
 * @file
 * Common types used in decoder and encoder API.
 */

#ifndef BROTLI_COMMON_TYPES_H_
#define BROTLI_COMMON_TYPES_H_

#include <stddef.h>  /* IWYU pragma: export */

#if defined(_MSC_VER) && (_MSC_VER < 1600)
typedef __int8 int8_t;
typedef unsigned __int8 uint8_t;
typedef __int16 int16_t;
typedef unsigned __int16 uint16_t;
typedef __int32 int32_t;
typedef unsigned __int32 uint32_t;
typedef unsigned __int64 uint64_t;
typedef __int64 int64_t;
#else
#include <stdint.h>  /* IWYU pragma: export */
#endif  /* defined(_MSC_VER) && (_MSC_VER < 1600) */

/**
 * A portable @c bool replacement.
 *
 * ::BROTLI_BOOL is a "documentation" type: actually it is @c int, but in API it
 * denotes a type, whose only values are ::BROTLI_TRUE and ::BROTLI_FALSE.
 *
 * ::BROTLI_BOOL values passed to Brotli should either be ::BROTLI_TRUE or
 * ::BROTLI_FALSE, or be a result of ::TO_BROTLI_BOOL macros.
 *
 * ::BROTLI_BOOL values returned by Brotli should not be tested for equality
 * with @c true, @c false, ::BROTLI_TRUE, ::BROTLI_FALSE, but rather should be
 * evaluated, for example: @code{.cpp}
 * if (SomeBrotliFunction(encoder, BROTLI_TRUE) &&
 *     !OtherBrotliFunction(decoder, BROTLI_FALSE)) {
 *   bool x = !!YetAnotherBrotliFunction(encoder, TO_BROLTI_BOOL(2 * 2 == 4));
 *   DoSomething(x);
 * }
 * @endcode
 */
#define BROTLI_BOOL int
/** Portable @c true replacement. */
#define BROTLI_TRUE 1
/** Portable @c false replacement. */
#define BROTLI_FALSE 0
/** @c bool to ::BROTLI_BOOL conversion macros. */
#define TO_BROTLI_BOOL(X) (!!(X) ? BROTLI_TRUE : BROTLI_FALSE)

#define BROTLI_MAKE_UINT64_T(high, low) ((((uint64_t)(high)) << 32) | low)

#define BROTLI_UINT32_MAX (~((uint32_t)0))
#define BROTLI_SIZE_MAX (~((size_t)0))

/**
 * Allocating function pointer type.
 *
 * @param opaque custom memory manager handle provided by client
 * @param size requested memory region size; can not be @c 0
 * @returns @c 0 in the case of failure
 * @returns a valid pointer to a memory region of at least @p size bytes
 *          long otherwise
 */
typedef void* (*brotli_alloc_func)(void* opaque, size_t size);

/**
 * Deallocating function pointer type.
 *
 * This function @b SHOULD do nothing if @p address is @c 0.
 *
 * @param opaque custom memory manager handle provided by client
 * @param address memory region pointer returned by ::brotli_alloc_func, or @c 0
 */
typedef void (*brotli_free_func)(void* opaque, void* address);

#endif  /* BROTLI_COMMON_TYPES_H_ */
