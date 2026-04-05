/*
 * Copyright © 2018, VideoLAN and dav1d authors
 * Copyright © 2018, Two Orioles, LLC
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#ifndef DAV1D_DATA_H
#define DAV1D_DATA_H

#include <stddef.h>
#include <stdint.h>

#include "common.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct Dav1dData {
    const uint8_t *data; ///< data pointer
    size_t sz; ///< data size
    struct Dav1dRef *ref; ///< allocation origin
    Dav1dDataProps m; ///< user provided metadata passed to the output picture
} Dav1dData;

/**
 * Allocate data.
 *
 * @param data Input context.
 * @param   sz Size of the data that should be allocated.
 *
 * @return Pointer to the allocated buffer on success. NULL on error.
 */
DAV1D_API uint8_t * dav1d_data_create(Dav1dData *data, size_t sz);

/**
 * Wrap an existing data array.
 *
 * @param          data Input context.
 * @param           buf The data to be wrapped.
 * @param            sz Size of the data.
 * @param free_callback Function to be called when we release our last
 *                      reference to this data. In this callback, $buf will be
 *                      the $buf argument to this function, and $cookie will
 *                      be the $cookie input argument to this function.
 * @param        cookie Opaque parameter passed to free_callback().
 *
 * @return 0 on success. A negative DAV1D_ERR value on error.
 */
DAV1D_API int dav1d_data_wrap(Dav1dData *data, const uint8_t *buf, size_t sz,
                              void (*free_callback)(const uint8_t *buf, void *cookie),
                              void *cookie);

/**
 * Wrap a user-provided data pointer into a reference counted object.
 *
 * data->m.user_data field will initialized to wrap the provided $user_data
 * pointer.
 *
 * $free_callback will be called on the same thread that released the last
 * reference. If frame threading is used, make sure $free_callback is
 * thread-safe.
 *
 * @param          data Input context.
 * @param     user_data The user data to be wrapped.
 * @param free_callback Function to be called when we release our last
 *                      reference to this data. In this callback, $user_data
 *                      will be the $user_data argument to this function, and
 *                      $cookie will be the $cookie input argument to this
 *                      function.
 * @param        cookie Opaque parameter passed to $free_callback.
 *
 * @return 0 on success. A negative DAV1D_ERR value on error.
 */
DAV1D_API int dav1d_data_wrap_user_data(Dav1dData *data,
                                        const uint8_t *user_data,
                                        void (*free_callback)(const uint8_t *user_data,
                                                              void *cookie),
                                        void *cookie);

/**
 * Free the data reference.
 *
 * The reference count for data->m.user_data will be decremented (if it has been
 * initialized with dav1d_data_wrap_user_data). The $data object will be memset
 * to 0.
 *
 * @param data Input context.
 */
DAV1D_API void dav1d_data_unref(Dav1dData *data);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* DAV1D_DATA_H */
