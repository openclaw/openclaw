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

/**
 * @file
 * @ingroup lavu_fifo
 * A generic FIFO API
 */

#ifndef AVUTIL_FIFO_H
#define AVUTIL_FIFO_H

#include <stddef.h>

/**
 * @defgroup lavu_fifo AVFifo
 * @ingroup lavu_data
 *
 * @{
 * A generic FIFO API
 */

typedef struct AVFifo AVFifo;

/**
 * Callback for writing or reading from a FIFO, passed to (and invoked from) the
 * av_fifo_*_cb() functions. It may be invoked multiple times from a single
 * av_fifo_*_cb() call and may process less data than the maximum size indicated
 * by nb_elems.
 *
 * @param opaque the opaque pointer provided to the av_fifo_*_cb() function
 * @param buf the buffer for reading or writing the data, depending on which
 *            av_fifo_*_cb function is called
 * @param nb_elems On entry contains the maximum number of elements that can be
 *                 read from / written into buf. On success, the callback should
 *                 update it to contain the number of elements actually written.
 *
 * @return 0 on success, a negative error code on failure (will be returned from
 *         the invoking av_fifo_*_cb() function)
 */
typedef int AVFifoCB(void *opaque, void *buf, size_t *nb_elems);

/**
 * Automatically resize the FIFO on writes, so that the data fits. This
 * automatic resizing happens up to a limit that can be modified with
 * av_fifo_auto_grow_limit().
 */
#define AV_FIFO_FLAG_AUTO_GROW      (1 << 0)

/**
 * Allocate and initialize an AVFifo with a given element size.
 *
 * @param elems     initial number of elements that can be stored in the FIFO
 * @param elem_size Size in bytes of a single element. Further operations on
 *                  the returned FIFO will implicitly use this element size.
 * @param flags a combination of AV_FIFO_FLAG_*
 *
 * @return newly-allocated AVFifo on success, a negative error code on failure
 */
AVFifo *av_fifo_alloc2(size_t elems, size_t elem_size,
                       unsigned int flags);

/**
 * @return Element size for FIFO operations. This element size is set at
 *         FIFO allocation and remains constant during its lifetime
 */
size_t av_fifo_elem_size(const AVFifo *f);

/**
 * Set the maximum size (in elements) to which the FIFO can be resized
 * automatically. Has no effect unless AV_FIFO_FLAG_AUTO_GROW is used.
 */
void av_fifo_auto_grow_limit(AVFifo *f, size_t max_elems);

/**
 * @return number of elements available for reading from the given FIFO.
 */
size_t av_fifo_can_read(const AVFifo *f);

/**
 * @return Number of elements that can be written into the given FIFO without
 *         growing it.
 *
 *         In other words, this number of elements or less is guaranteed to fit
 *         into the FIFO. More data may be written when the
 *         AV_FIFO_FLAG_AUTO_GROW flag was specified at FIFO creation, but this
 *         may involve memory allocation, which can fail.
 */
size_t av_fifo_can_write(const AVFifo *f);

/**
 * Enlarge an AVFifo.
 *
 * On success, the FIFO will be large enough to hold exactly
 * inc + av_fifo_can_read() + av_fifo_can_write()
 * elements. In case of failure, the old FIFO is kept unchanged.
 *
 * @param f AVFifo to resize
 * @param inc number of elements to allocate for, in addition to the current
 *            allocated size
 * @return a non-negative number on success, a negative error code on failure
 */
int av_fifo_grow2(AVFifo *f, size_t inc);

/**
 * Write data into a FIFO.
 *
 * In case nb_elems > av_fifo_can_write(f) and the AV_FIFO_FLAG_AUTO_GROW flag
 * was not specified at FIFO creation, nothing is written and an error
 * is returned.
 *
 * Calling function is guaranteed to succeed if nb_elems <= av_fifo_can_write(f).
 *
 * @param f the FIFO buffer
 * @param buf Data to be written. nb_elems * av_fifo_elem_size(f) bytes will be
 *            read from buf on success.
 * @param nb_elems number of elements to write into FIFO
 *
 * @return a non-negative number on success, a negative error code on failure
 */
int av_fifo_write(AVFifo *f, const void *buf, size_t nb_elems);

/**
 * Write data from a user-provided callback into a FIFO.
 *
 * @param f the FIFO buffer
 * @param read_cb Callback supplying the data to the FIFO. May be called
 *                multiple times.
 * @param opaque opaque user data to be provided to read_cb
 * @param nb_elems Should point to the maximum number of elements that can be
 *                 written. Will be updated to contain the number of elements
 *                 actually written.
 *
 * @return non-negative number on success, a negative error code on failure
 */
int av_fifo_write_from_cb(AVFifo *f, AVFifoCB read_cb,
                          void *opaque, size_t *nb_elems);

/**
 * Read data from a FIFO.
 *
 * In case nb_elems > av_fifo_can_read(f), nothing is read and an error
 * is returned.
 *
 * @param f the FIFO buffer
 * @param buf Buffer to store the data. nb_elems * av_fifo_elem_size(f) bytes
 *            will be written into buf on success.
 * @param nb_elems number of elements to read from FIFO
 *
 * @return a non-negative number on success, a negative error code on failure
 */
int av_fifo_read(AVFifo *f, void *buf, size_t nb_elems);

/**
 * Feed data from a FIFO into a user-provided callback.
 *
 * @param f the FIFO buffer
 * @param write_cb Callback the data will be supplied to. May be called
 *                 multiple times.
 * @param opaque opaque user data to be provided to write_cb
 * @param nb_elems Should point to the maximum number of elements that can be
 *                 read. Will be updated to contain the total number of elements
 *                 actually sent to the callback.
 *
 * @return non-negative number on success, a negative error code on failure
 */
int av_fifo_read_to_cb(AVFifo *f, AVFifoCB write_cb,
                       void *opaque, size_t *nb_elems);

/**
 * Read data from a FIFO without modifying FIFO state.
 *
 * Returns an error if an attempt is made to peek to nonexistent elements
 * (i.e. if offset + nb_elems is larger than av_fifo_can_read(f)).
 *
 * @param f the FIFO buffer
 * @param buf Buffer to store the data. nb_elems * av_fifo_elem_size(f) bytes
 *            will be written into buf.
 * @param nb_elems number of elements to read from FIFO
 * @param offset number of initial elements to skip.
 *
 * @return a non-negative number on success, a negative error code on failure
 */
int av_fifo_peek(const AVFifo *f, void *buf, size_t nb_elems, size_t offset);

/**
 * Feed data from a FIFO into a user-provided callback.
 *
 * @param f the FIFO buffer
 * @param write_cb Callback the data will be supplied to. May be called
 *                 multiple times.
 * @param opaque opaque user data to be provided to write_cb
 * @param nb_elems Should point to the maximum number of elements that can be
 *                 read. Will be updated to contain the total number of elements
 *                 actually sent to the callback.
 * @param offset number of initial elements to skip; offset + *nb_elems must not
 *               be larger than av_fifo_can_read(f).
 *
 * @return a non-negative number on success, a negative error code on failure
 */
int av_fifo_peek_to_cb(const AVFifo *f, AVFifoCB write_cb, void *opaque,
                       size_t *nb_elems, size_t offset);

/**
 * Discard the specified amount of data from an AVFifo.
 * @param size number of elements to discard, MUST NOT be larger than
 *             av_fifo_can_read(f)
 */
void av_fifo_drain2(AVFifo *f, size_t size);

/*
 * Empty the AVFifo.
 * @param f AVFifo to reset
 */
void av_fifo_reset2(AVFifo *f);

/**
 * Free an AVFifo and reset pointer to NULL.
 * @param f Pointer to an AVFifo to free. *f == NULL is allowed.
 */
void av_fifo_freep2(AVFifo **f);

/**
 * @}
 */

#endif /* AVUTIL_FIFO_H */
