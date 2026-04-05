/*
 *  Copyright (c) 2010 The WebM project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree. An additional intellectual property rights grant can be found
 *  in the file PATENTS.  All contributing project authors may
 *  be found in the AUTHORS file in the root of the source tree.
 */

#ifndef VPX_VPX_VPX_INTEGER_H_
#define VPX_VPX_VPX_INTEGER_H_

/* get ptrdiff_t, size_t, wchar_t, NULL */
#include <stddef.h>  // IWYU pragma: export

#if defined(_MSC_VER)
#define VPX_FORCE_INLINE __forceinline
#define VPX_INLINE __inline
#else
#define VPX_FORCE_INLINE __inline__ __attribute__((always_inline))
// TODO(jbb): Allow a way to force inline off for older compilers.
#define VPX_INLINE inline
#endif

/* Assume platforms have the C99 standard integer types. */

#if defined(__cplusplus)
#if !defined(__STDC_FORMAT_MACROS)
#define __STDC_FORMAT_MACROS
#endif
#if !defined(__STDC_LIMIT_MACROS)
#define __STDC_LIMIT_MACROS
#endif
#endif  // __cplusplus

#include <inttypes.h>  // IWYU pragma: export
#include <stdint.h>    // IWYU pragma: export

#endif  // VPX_VPX_VPX_INTEGER_H_
