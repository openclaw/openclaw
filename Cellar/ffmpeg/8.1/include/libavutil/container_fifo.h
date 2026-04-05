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

#ifndef AVUTIL_CONTAINER_FIFO_H
#define AVUTIL_CONTAINER_FIFO_H

#include <stddef.h>

/**
 * AVContainerFifo is a FIFO for "containers" - dynamically allocated reusable
 * structs (e.g. AVFrame or AVPacket). AVContainerFifo uses an internal pool of
 * such containers to avoid allocating and freeing them repeatedly.
 */
typedef struct AVContainerFifo AVContainerFifo;

enum AVContainerFifoFlags {
    /**
     * Signal to av_container_fifo_write() that it should make a new reference
     * to data in src rather than consume its contents.
     *
     * @note you must handle this flag manually in your own fifo_transfer()
     *       callback
     */
    AV_CONTAINER_FIFO_FLAG_REF  = (1 << 0),

    /**
     * This and all higher bits in flags may be set to any value by the caller
     * and are guaranteed to be passed through to the fifo_transfer() callback
     * and not be interpreted by AVContainerFifo code.
     */
    AV_CONTAINER_FIFO_FLAG_USER = (1 << 16),
};

/**
 * Allocate a new AVContainerFifo for the container type defined by provided
 * callbacks.
 *
 * @param opaque user data that will be passed to the callbacks provided to this
 *               function
 * @param container_alloc allocate a new container instance and return a pointer
 *                        to it, or NULL on failure
 * @param container_reset reset the provided container instance to a clean state
 * @param container_free free the provided container instance
 * @param fifo_transfer Transfer the contents of container src to dst.
 * @param flags currently unused
 *
 * @return newly allocated AVContainerFifo, or NULL on failure
 */
AVContainerFifo*
av_container_fifo_alloc(void *opaque,
                        void* (*container_alloc)(void *opaque),
                        void  (*container_reset)(void *opaque, void *obj),
                        void  (*container_free) (void *opaque, void *obj),
                        int   (*fifo_transfer)  (void *opaque, void *dst, void *src, unsigned flags),
                        unsigned flags);

/**
 * Allocate an AVContainerFifo instance for AVFrames.
 *
 * @param flags currently unused
 */
AVContainerFifo *av_container_fifo_alloc_avframe(unsigned flags);

/**
 * Free a AVContainerFifo and everything in it.
 */
void av_container_fifo_free(AVContainerFifo **cf);

/**
 * Write the contents of obj to the FIFO.
 *
 * The fifo_transfer() callback previously provided to av_container_fifo_alloc()
 * will be called with obj as src in order to perform the actual transfer.
 */
int av_container_fifo_write(AVContainerFifo *cf, void *obj, unsigned flags);

/**
 * Read the next available object from the FIFO into obj.
 *
 * The fifo_read() callback previously provided to av_container_fifo_alloc()
 * will be called with obj as dst in order to perform the actual transfer.
 */
int av_container_fifo_read(AVContainerFifo *cf, void *obj, unsigned flags);

/**
 * Access objects stored in the FIFO without retrieving them. The
 * fifo_transfer() callback will NOT be invoked and the FIFO state will not be
 * modified.
 *
 * @param pobj Pointer to the object stored in the FIFO will be written here on
 *             success. The object remains owned by the FIFO and the caller may
 *             only access it as long as the FIFO is not modified.
 * @param offset Position of the object to retrieve - 0 is the next item that
 *               would be read, 1 the one after, etc. Must be smaller than
 *               av_container_fifo_can_read().
 *
 * @retval 0 success, a pointer was written into pobj
 * @retval AVERROR(EINVAL) invalid offset value
 */
int av_container_fifo_peek(AVContainerFifo *cf, void **pobj, size_t offset);

/**
 * Discard the specified number of elements from the FIFO.
 *
 * @param nb_elems number of elements to discard, MUST NOT be larger than
 *                 av_fifo_can_read(f)
 */
void av_container_fifo_drain(AVContainerFifo *cf, size_t nb_elems);

/**
 * @return number of objects available for reading
 */
size_t av_container_fifo_can_read(const AVContainerFifo *cf);

#endif // AVCODEC_CONTAINER_FIFO_H
