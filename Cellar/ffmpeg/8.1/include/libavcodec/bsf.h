/*
 * Bitstream filters public API
 *
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

#ifndef AVCODEC_BSF_H
#define AVCODEC_BSF_H

#include "libavutil/dict.h"
#include "libavutil/log.h"
#include "libavutil/rational.h"

#include "codec_id.h"
#include "codec_par.h"
#include "packet.h"

/**
 * @defgroup lavc_bsf Bitstream filters
 * @ingroup libavc
 *
 * Bitstream filters transform encoded media data without decoding it. This
 * allows e.g. manipulating various header values. Bitstream filters operate on
 * @ref AVPacket "AVPackets".
 *
 * The bitstream filtering API is centered around two structures:
 * AVBitStreamFilter and AVBSFContext. The former represents a bitstream filter
 * in abstract, the latter a specific filtering process. Obtain an
 * AVBitStreamFilter using av_bsf_get_by_name() or av_bsf_iterate(), then pass
 * it to av_bsf_alloc() to create an AVBSFContext. Fill in the user-settable
 * AVBSFContext fields, as described in its documentation, then call
 * av_bsf_init() to prepare the filter context for use.
 *
 * Submit packets for filtering using av_bsf_send_packet(), obtain filtered
 * results with av_bsf_receive_packet(). When no more input packets will be
 * sent, submit a NULL AVPacket to signal the end of the stream to the filter.
 * av_bsf_receive_packet() will then return trailing packets, if any are
 * produced by the filter.
 *
 * Finally, free the filter context with av_bsf_free().
 * @{
 */

/**
 * The bitstream filter state.
 *
 * This struct must be allocated with av_bsf_alloc() and freed with
 * av_bsf_free().
 *
 * The fields in the struct will only be changed (by the caller or by the
 * filter) as described in their documentation, and are to be considered
 * immutable otherwise.
 */
typedef struct AVBSFContext {
    /**
     * A class for logging and AVOptions
     */
    const AVClass *av_class;

    /**
     * The bitstream filter this context is an instance of.
     */
    const struct AVBitStreamFilter *filter;

    /**
     * Opaque filter-specific private data. If filter->priv_class is non-NULL,
     * this is an AVOptions-enabled struct.
     */
    void *priv_data;

    /**
     * Parameters of the input stream. This field is allocated in
     * av_bsf_alloc(), it needs to be filled by the caller before
     * av_bsf_init().
     */
    AVCodecParameters *par_in;

    /**
     * Parameters of the output stream. This field is allocated in
     * av_bsf_alloc(), it is set by the filter in av_bsf_init().
     */
    AVCodecParameters *par_out;

    /**
     * The timebase used for the timestamps of the input packets. Set by the
     * caller before av_bsf_init().
     */
    AVRational time_base_in;

    /**
     * The timebase used for the timestamps of the output packets. Set by the
     * filter in av_bsf_init().
     */
    AVRational time_base_out;
} AVBSFContext;

typedef struct AVBitStreamFilter {
    const char *name;

    /**
     * A list of codec ids supported by the filter, terminated by
     * AV_CODEC_ID_NONE.
     * May be NULL, in that case the bitstream filter works with any codec id.
     */
    const enum AVCodecID *codec_ids;

    /**
     * A class for the private data, used to declare bitstream filter private
     * AVOptions. This field is NULL for bitstream filters that do not declare
     * any options.
     *
     * If this field is non-NULL, the first member of the filter private data
     * must be a pointer to AVClass, which will be set by libavcodec generic
     * code to this class.
     */
    const AVClass *priv_class;
} AVBitStreamFilter;

/**
 * @return a bitstream filter with the specified name or NULL if no such
 *         bitstream filter exists.
 */
const AVBitStreamFilter *av_bsf_get_by_name(const char *name);

/**
 * Iterate over all registered bitstream filters.
 *
 * @param opaque a pointer where libavcodec will store the iteration state. Must
 *               point to NULL to start the iteration.
 *
 * @return the next registered bitstream filter or NULL when the iteration is
 *         finished
 */
const AVBitStreamFilter *av_bsf_iterate(void **opaque);

/**
 * Allocate a context for a given bitstream filter. The caller must fill in the
 * context parameters as described in the documentation and then call
 * av_bsf_init() before sending any data to the filter.
 *
 * @param filter the filter for which to allocate an instance.
 * @param[out] ctx a pointer into which the pointer to the newly-allocated context
 *                 will be written. It must be freed with av_bsf_free() after the
 *                 filtering is done.
 *
 * @return 0 on success, a negative AVERROR code on failure
 */
int av_bsf_alloc(const AVBitStreamFilter *filter, AVBSFContext **ctx);

/**
 * Prepare the filter for use, after all the parameters and options have been
 * set.
 *
 * @param ctx a AVBSFContext previously allocated with av_bsf_alloc()
 */
int av_bsf_init(AVBSFContext *ctx);

/**
 * Submit a packet for filtering.
 *
 * After sending each packet, the filter must be completely drained by calling
 * av_bsf_receive_packet() repeatedly until it returns AVERROR(EAGAIN) or
 * AVERROR_EOF.
 *
 * @param ctx an initialized AVBSFContext
 * @param pkt the packet to filter. The bitstream filter will take ownership of
 * the packet and reset the contents of pkt. pkt is not touched if an error occurs.
 * If pkt is empty (i.e. NULL, or pkt->data is NULL and pkt->side_data_elems zero),
 * it signals the end of the stream (i.e. no more non-empty packets will be sent;
 * sending more empty packets does nothing) and will cause the filter to output
 * any packets it may have buffered internally.
 *
 * @return
 *  - 0 on success.
 *  - AVERROR(EAGAIN) if packets need to be retrieved from the filter (using
 *    av_bsf_receive_packet()) before new input can be consumed.
 *  - Another negative AVERROR value if an error occurs.
 */
int av_bsf_send_packet(AVBSFContext *ctx, AVPacket *pkt);

/**
 * Retrieve a filtered packet.
 *
 * @param ctx an initialized AVBSFContext
 * @param[out] pkt this struct will be filled with the contents of the filtered
 *                 packet. It is owned by the caller and must be freed using
 *                 av_packet_unref() when it is no longer needed.
 *                 This parameter should be "clean" (i.e. freshly allocated
 *                 with av_packet_alloc() or unreffed with av_packet_unref())
 *                 when this function is called. If this function returns
 *                 successfully, the contents of pkt will be completely
 *                 overwritten by the returned data. On failure, pkt is not
 *                 touched.
 *
 * @return
 *  - 0 on success.
 *  - AVERROR(EAGAIN) if more packets need to be sent to the filter (using
 *    av_bsf_send_packet()) to get more output.
 *  - AVERROR_EOF if there will be no further output from the filter.
 *  - Another negative AVERROR value if an error occurs.
 *
 * @note one input packet may result in several output packets, so after sending
 * a packet with av_bsf_send_packet(), this function needs to be called
 * repeatedly until it stops returning 0. It is also possible for a filter to
 * output fewer packets than were sent to it, so this function may return
 * AVERROR(EAGAIN) immediately after a successful av_bsf_send_packet() call.
 */
int av_bsf_receive_packet(AVBSFContext *ctx, AVPacket *pkt);

/**
 * Reset the internal bitstream filter state. Should be called e.g. when seeking.
 */
void av_bsf_flush(AVBSFContext *ctx);

/**
 * Free a bitstream filter context and everything associated with it; write NULL
 * into the supplied pointer.
 */
void av_bsf_free(AVBSFContext **ctx);

/**
 * Get the AVClass for AVBSFContext. It can be used in combination with
 * AV_OPT_SEARCH_FAKE_OBJ for examining options.
 *
 * @see av_opt_find().
 */
const AVClass *av_bsf_get_class(void);

/**
 * Structure for chain/list of bitstream filters.
 * Empty list can be allocated by av_bsf_list_alloc().
 */
typedef struct AVBSFList AVBSFList;

/**
 * Allocate empty list of bitstream filters.
 * The list must be later freed by av_bsf_list_free()
 * or finalized by av_bsf_list_finalize().
 *
 * @return Pointer to @ref AVBSFList on success, NULL in case of failure
 */
AVBSFList *av_bsf_list_alloc(void);

/**
 * Free list of bitstream filters.
 *
 * @param lst Pointer to pointer returned by av_bsf_list_alloc()
 */
void av_bsf_list_free(AVBSFList **lst);

/**
 * Append bitstream filter to the list of bitstream filters.
 *
 * @param lst List to append to
 * @param bsf Filter context to be appended
 *
 * @return >=0 on success, negative AVERROR in case of failure
 */
int av_bsf_list_append(AVBSFList *lst, AVBSFContext *bsf);

/**
 * Construct new bitstream filter context given it's name and options
 * and append it to the list of bitstream filters.
 *
 * @param lst      List to append to
 * @param bsf_name Name of the bitstream filter
 * @param options  Options for the bitstream filter, can be set to NULL
 *
 * @return >=0 on success, negative AVERROR in case of failure
 */
int av_bsf_list_append2(AVBSFList *lst, const char * bsf_name, AVDictionary **options);
/**
 * Finalize list of bitstream filters.
 *
 * This function will transform @ref AVBSFList to single @ref AVBSFContext,
 * so the whole chain of bitstream filters can be treated as single filter
 * freshly allocated by av_bsf_alloc().
 * If the call is successful, @ref AVBSFList structure is freed and lst
 * will be set to NULL. In case of failure, caller is responsible for
 * freeing the structure by av_bsf_list_free()
 *
 * @param      lst Filter list structure to be transformed
 * @param[out] bsf Pointer to be set to newly created @ref AVBSFContext structure
 *                 representing the chain of bitstream filters
 *
 * @return >=0 on success, negative AVERROR in case of failure
 */
int av_bsf_list_finalize(AVBSFList **lst, AVBSFContext **bsf);

/**
 * Parse string describing list of bitstream filters and create single
 * @ref AVBSFContext describing the whole chain of bitstream filters.
 * Resulting @ref AVBSFContext can be treated as any other @ref AVBSFContext freshly
 * allocated by av_bsf_alloc().
 *
 * @param      str String describing chain of bitstream filters in format
 *                 `bsf1[=opt1=val1:opt2=val2][,bsf2]`
 * @param[out] bsf Pointer to be set to newly created @ref AVBSFContext structure
 *                 representing the chain of bitstream filters
 *
 * @return >=0 on success, negative AVERROR in case of failure
 */
int av_bsf_list_parse_str(const char *str, AVBSFContext **bsf);

/**
 * Get null/pass-through bitstream filter.
 *
 * @param[out] bsf Pointer to be set to new instance of pass-through bitstream filter
 *
 * @return
 */
int av_bsf_get_null_filter(AVBSFContext **bsf);

/**
 * @}
 */

#endif // AVCODEC_BSF_H
