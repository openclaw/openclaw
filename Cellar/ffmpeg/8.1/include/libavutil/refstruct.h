/*
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * FFmpeg is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with FFmpeg; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

#ifndef AVUTIL_REFSTRUCT_H
#define AVUTIL_REFSTRUCT_H

#include <stddef.h>

/**
 * RefStruct is an API for creating reference-counted objects
 * with minimal overhead. The API is designed for objects,
 * not buffers like the AVBuffer API. The main differences
 * to the AVBuffer API are as follows:
 *
 * - It uses void* instead of uint8_t* as its base type due to
 *   its focus on objects.
 * - There are no equivalents of AVBuffer and AVBufferRef.
 *   E.g. there is no way to get the usable size of the object:
 *   The user is supposed to know what is at the other end of
 *   the pointer. It also avoids one level of indirection.
 * - Custom allocators are not supported. This allows to simplify
 *   the implementation and reduce the amount of allocations.
 * - It also has the advantage that the user's free callback need
 *   only free the resources owned by the object, but not the
 *   object itself.
 * - Because referencing (and replacing) an object managed by the
 *   RefStruct API does not involve allocations, they can not fail
 *   and therefore need not be checked.
 *
 * @note Referencing and unreferencing the buffers is thread-safe and thus
 * may be done from multiple threads simultaneously without any need for
 * additional locking.
 */

/**
 * This union is used for all opaque parameters in this API to spare the user
 * to cast const away in case the opaque to use is const-qualified.
 *
 * The functions provided by this API with an AVRefStructOpaque come in pairs
 * named foo_c and foo. The foo function accepts void* as opaque and is just
 * a wrapper around the foo_c function; "_c" means "(potentially) const".
 */
typedef union {
    void *nc;
    const void *c;
} AVRefStructOpaque;

/**
 * If this flag is set in av_refstruct_alloc_ext_c(), the object will not
 * be initially zeroed.
 */
#define AV_REFSTRUCT_FLAG_NO_ZEROING (1 << 0)

/**
 * Allocate a refcounted object of usable size `size` managed via
 * the RefStruct API.
 *
 * By default (in the absence of flags to the contrary),
 * the returned object is initially zeroed.
 *
 * @param size    Desired usable size of the returned object.
 * @param flags   A bitwise combination of AV_REFSTRUCT_FLAG_* flags.
 * @param opaque  A pointer that will be passed to the free_cb callback.
 * @param free_cb A callback for freeing this object's content
 *                when its reference count reaches zero;
 *                it must not free the object itself.
 * @return A pointer to an object of the desired size or NULL on failure.
 */
void *av_refstruct_alloc_ext_c(size_t size, unsigned flags, AVRefStructOpaque opaque,
                               void (*free_cb)(AVRefStructOpaque opaque, void *obj));

/**
 * A wrapper around av_refstruct_alloc_ext_c() for the common case
 * of a non-const qualified opaque.
 *
 * @see av_refstruct_alloc_ext_c()
 */
static inline
void *av_refstruct_alloc_ext(size_t size, unsigned flags, void *opaque,
                             void (*free_cb)(AVRefStructOpaque opaque, void *obj))
{
    return av_refstruct_alloc_ext_c(size, flags, (AVRefStructOpaque){.nc = opaque},
                                    free_cb);
}

/**
 * Equivalent to av_refstruct_alloc_ext(size, 0, NULL, NULL)
 */
static inline
void *av_refstruct_allocz(size_t size)
{
    return av_refstruct_alloc_ext(size, 0, NULL, NULL);
}

/**
 * Decrement the reference count of the underlying object and automatically
 * free the object if there are no more references to it.
 *
 * `*objp == NULL` is legal and a no-op.
 *
 * @param objp Pointer to a pointer that is either NULL or points to an object
 *             managed via this API. `*objp` is set to NULL on return.
 */
void av_refstruct_unref(void *objp);

/**
 * Create a new reference to an object managed via this API,
 * i.e. increment the reference count of the underlying object
 * and return obj.
 * @return a pointer equal to obj.
 */
void *av_refstruct_ref(void *obj);

/**
 * Analog of av_refstruct_ref(), but for constant objects.
 * @see av_refstruct_ref()
 */
const void *av_refstruct_ref_c(const void *obj);

/**
 * Ensure `*dstp` refers to the same object as src.
 *
 * If `*dstp` is already equal to src, do nothing. Otherwise unreference `*dstp`
 * and replace it with a new reference to src in case `src != NULL` (this
 * involves incrementing the reference count of src's underlying object) or
 * with NULL otherwise.
 *
 * @param dstp Pointer to a pointer that is either NULL or points to an object
 *             managed via this API.
 * @param src  A pointer to an object managed via this API or NULL.
 */
void av_refstruct_replace(void *dstp, const void *src);

/**
 * Check whether the reference count of an object managed
 * via this API is 1.
 *
 * @param obj A pointer to an object managed via this API.
 * @return 1 if the reference count of obj is 1; 0 otherwise.
 */
int av_refstruct_exclusive(const void *obj);

/**
 * AVRefStructPool is an API for a thread-safe pool of objects managed
 * via the RefStruct API.
 *
 * Frequently allocating and freeing large or complicated objects may be slow
 * and wasteful. This API is meant to solve this in cases when the caller
 * needs a set of interchangeable objects.
 *
 * At the beginning, the user must call allocate the pool via
 * av_refstruct_pool_alloc() or its analogue av_refstruct_pool_alloc_ext().
 * Then whenever an object is needed, call av_refstruct_pool_get() to
 * get a new or reused object from the pool. This new object works in all
 * aspects the same way as the ones created by av_refstruct_alloc_ext().
 * However, when the last reference to this object is unreferenced, it is
 * (optionally) reset and returned to the pool instead of being freed and
 * will be reused for subsequent av_refstruct_pool_get() calls.
 *
 * When the caller is done with the pool and no longer needs to create any new
 * objects, av_refstruct_pool_uninit() must be called to mark the pool as
 * freeable. Then entries returned to the pool will then be freed.
 * Once all the entries are freed, the pool will automatically be freed.
 *
 * Allocating and releasing objects with this API is thread-safe as long as
 * the user-supplied callbacks (if provided) are thread-safe.
 */

/**
 * The buffer pool. This structure is opaque and not meant to be accessed
 * directly. It is allocated with the allocators below and freed with
 * av_refstruct_pool_uninit().
 */
typedef struct AVRefStructPool AVRefStructPool;

/**
 * If this flag is not set, every object in the pool will be zeroed before
 * the init callback is called or before it is turned over to the user
 * for the first time if no init callback has been provided.
 */
#define AV_REFSTRUCT_POOL_FLAG_NO_ZEROING         AV_REFSTRUCT_FLAG_NO_ZEROING
/**
 * If this flag is set and both init_cb and reset_cb callbacks are provided,
 * then reset_cb will be called if init_cb fails.
 * The object passed to reset_cb will be in the state left by init_cb.
 */
#define AV_REFSTRUCT_POOL_FLAG_RESET_ON_INIT_ERROR                   (1 << 16)
/**
 * If this flag is set and both init_cb and free_entry_cb callbacks are
 * provided, then free_cb will be called if init_cb fails.
 *
 * It will be called after reset_cb in case reset_cb and the
 * AV_REFSTRUCT_POOL_FLAG_RESET_ON_INIT_ERROR flag are also set.
 *
 * The object passed to free_cb will be in the state left by
 * the callbacks applied earlier (init_cb potentially followed by reset_cb).
 */
#define AV_REFSTRUCT_POOL_FLAG_FREE_ON_INIT_ERROR                    (1 << 17)
/**
 * If this flag is set, the entries will be zeroed before
 * being returned to the user (after the init or reset callbacks
 * have been called (if provided)). Furthermore, to avoid zeroing twice
 * it also makes the pool behave as if the AV_REFSTRUCT_POOL_FLAG_NO_ZEROING
 * flag had been provided.
 */
#define AV_REFSTRUCT_POOL_FLAG_ZERO_EVERY_TIME                       (1 << 18)

/**
 * Equivalent to av_refstruct_pool_alloc(size, flags, NULL, NULL, NULL, NULL, NULL)
 */
AVRefStructPool *av_refstruct_pool_alloc(size_t size, unsigned flags);

/**
 * Allocate an AVRefStructPool, potentially using complex callbacks.
 *
 * @param size size of the entries of the pool
 * @param flags a bitwise combination of AV_REFSTRUCT_POOL_FLAG_* flags
 * @param opaque A pointer that will be passed to the callbacks below.
 * @param init  A callback that will be called directly after a new entry
 *              has been allocated. obj has already been zeroed unless
 *              the AV_REFSTRUCT_POOL_FLAG_NO_ZEROING flag is in use.
 * @param reset A callback that will be called after an entry has been
 *              returned to the pool and before it is reused.
 * @param free_entry A callback that will be called when an entry is freed
 *                   after the pool has been marked as to be uninitialized.
 * @param free       A callback that will be called when the pool itself is
 *                   freed (after the last entry has been returned and freed).
 */
AVRefStructPool *av_refstruct_pool_alloc_ext_c(size_t size, unsigned flags,
                                               AVRefStructOpaque opaque,
                                               int  (*init_cb)(AVRefStructOpaque opaque, void *obj),
                                               void (*reset_cb)(AVRefStructOpaque opaque, void *obj),
                                               void (*free_entry_cb)(AVRefStructOpaque opaque, void *obj),
                                               void (*free_cb)(AVRefStructOpaque opaque));

/**
 * A wrapper around av_refstruct_pool_alloc_ext_c() for the common case
 * of a non-const qualified opaque.
 *
 * @see av_refstruct_pool_alloc_ext_c()
 */
static inline
AVRefStructPool *av_refstruct_pool_alloc_ext(size_t size, unsigned flags,
                                             void *opaque,
                                             int  (*init_cb)(AVRefStructOpaque opaque, void *obj),
                                             void (*reset_cb)(AVRefStructOpaque opaque, void *obj),
                                             void (*free_entry_cb)(AVRefStructOpaque opaque, void *obj),
                                             void (*free_cb)(AVRefStructOpaque opaque))
{
    return av_refstruct_pool_alloc_ext_c(size, flags, (AVRefStructOpaque){.nc = opaque},
                                         init_cb, reset_cb, free_entry_cb, free_cb);
}

/**
 * Get an object from the pool, reusing an old one from the pool when
 * available.
 *
 * Every call to this function must happen before av_refstruct_pool_uninit().
 * Otherwise undefined behaviour may occur.
 *
 * @param pool the pool from which to get the object
 * @return a reference to the object on success, NULL on error.
 */
void *av_refstruct_pool_get(AVRefStructPool *pool);

/**
 * Mark the pool as being available for freeing. It will actually be freed
 * only once all the allocated buffers associated with the pool are released.
 * Thus it is safe to call this function while some of the allocated buffers
 * are still in use.
 *
 * It is illegal to try to get a new entry after this function has been called.
 *
 * @param poolp pointer to a pointer to either NULL or a pool to be freed.
 *              `*poolp` will be set to NULL.
 */
static inline void av_refstruct_pool_uninit(AVRefStructPool **poolp)
{
    av_refstruct_unref(poolp);
}

#endif /* AVUTIL_REFSTRUCT_H */
