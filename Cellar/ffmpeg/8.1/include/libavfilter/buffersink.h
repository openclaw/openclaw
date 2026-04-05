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

#ifndef AVFILTER_BUFFERSINK_H
#define AVFILTER_BUFFERSINK_H

/**
 * @file
 * @ingroup lavfi_buffersink
 * memory buffer sink API for audio and video
 */

#include "avfilter.h"

/**
 * @defgroup lavfi_buffersink Buffer sink API
 * @ingroup lavfi
 * @{
 *
 * The buffersink and abuffersink filters are there to connect filter graphs
 * to applications. They have a single input, connected to the graph, and no
 * output. Frames must be extracted using av_buffersink_get_frame() or
 * av_buffersink_get_samples().
 *
 * The format negotiated by the graph during configuration can be obtained
 * using the accessor functions:
 * - av_buffersink_get_time_base(),
 * - av_buffersink_get_format(),
 * - av_buffersink_get_frame_rate(),
 * - av_buffersink_get_w(),
 * - av_buffersink_get_h(),
 * - av_buffersink_get_sample_aspect_ratio(),
 * - av_buffersink_get_channels(),
 * - av_buffersink_get_ch_layout(),
 * - av_buffersink_get_sample_rate().
 * - av_buffersink_get_side_data().
 *
 * The layout returned by av_buffersink_get_ch_layout() must de uninitialized
 * by the caller.
 *
 * The format can be constrained by setting options, using av_opt_set() and
 * related functions with the AV_OPT_SEARCH_CHILDREN flag.
 *  - pixel_formats (array of pixel formats),
 *  - colorspaces (array of int),
 *  - colorranges (array of int),
 *  - alphamodes (array of int),
 *  - sample_formats (array of sample formats),
 *  - samplerates (array of int),
 *  - channel_layouts (array of channel layouts)
 * If an option is not set, all corresponding formats are accepted.
 */

/**
 * Get a frame with filtered data from sink and put it in frame.
 *
 * @param ctx    pointer to a buffersink or abuffersink filter context.
 * @param frame  pointer to an allocated frame that will be filled with data.
 *               The data must be freed using av_frame_unref() / av_frame_free()
 * @param flags  a combination of AV_BUFFERSINK_FLAG_* flags
 *
 * @return  >= 0 in for success, a negative AVERROR code for failure.
 */
int av_buffersink_get_frame_flags(AVFilterContext *ctx, AVFrame *frame, int flags);

/**
 * Tell av_buffersink_get_buffer_ref() to read video/samples buffer
 * reference, but not remove it from the buffer. This is useful if you
 * need only to read a video/samples buffer, without to fetch it.
 */
#define AV_BUFFERSINK_FLAG_PEEK 1

/**
 * Tell av_buffersink_get_buffer_ref() not to request a frame from its input.
 * If a frame is already buffered, it is read (and removed from the buffer),
 * but if no frame is present, return AVERROR(EAGAIN).
 */
#define AV_BUFFERSINK_FLAG_NO_REQUEST 2

/**
 * Set the frame size for an audio buffer sink.
 *
 * All calls to av_buffersink_get_buffer_ref will return a buffer with
 * exactly the specified number of samples, or AVERROR(EAGAIN) if there is
 * not enough. The last buffer at EOF will be padded with 0.
 */
void av_buffersink_set_frame_size(AVFilterContext *ctx, unsigned frame_size);

/**
 * @defgroup lavfi_buffersink_accessors Buffer sink accessors
 * Get the properties of the stream
 * @{
 */

enum AVMediaType av_buffersink_get_type                (const AVFilterContext *ctx);
AVRational       av_buffersink_get_time_base           (const AVFilterContext *ctx);
int              av_buffersink_get_format              (const AVFilterContext *ctx);

AVRational       av_buffersink_get_frame_rate          (const AVFilterContext *ctx);
int              av_buffersink_get_w                   (const AVFilterContext *ctx);
int              av_buffersink_get_h                   (const AVFilterContext *ctx);
AVRational       av_buffersink_get_sample_aspect_ratio (const AVFilterContext *ctx);
enum AVColorSpace av_buffersink_get_colorspace         (const AVFilterContext *ctx);
enum AVColorRange av_buffersink_get_color_range        (const AVFilterContext *ctx);
enum AVAlphaMode  av_buffersink_get_alpha_mode         (const AVFilterContext *ctx);

int              av_buffersink_get_channels            (const AVFilterContext *ctx);
int              av_buffersink_get_ch_layout           (const AVFilterContext *ctx,
                                                        AVChannelLayout *ch_layout);
int              av_buffersink_get_sample_rate         (const AVFilterContext *ctx);

AVBufferRef *    av_buffersink_get_hw_frames_ctx       (const AVFilterContext *ctx);

const AVFrameSideData *const *av_buffersink_get_side_data(const AVFilterContext *ctx,
                                                          int *nb_side_data);

/** @} */

/**
 * Get a frame with filtered data from sink and put it in frame.
 *
 * @param ctx pointer to a context of a buffersink or abuffersink AVFilter.
 * @param frame pointer to an allocated frame that will be filled with data.
 *              The data must be freed using av_frame_unref() / av_frame_free()
 *
 * @return
 *         - >= 0 if a frame was successfully returned.
 *         - AVERROR(EAGAIN) if no frames are available at this point; more
 *           input frames must be added to the filtergraph to get more output.
 *         - AVERROR_EOF if there will be no more output frames on this sink.
 *         - A different negative AVERROR code in other failure cases.
 */
int av_buffersink_get_frame(AVFilterContext *ctx, AVFrame *frame);

/**
 * Same as av_buffersink_get_frame(), but with the ability to specify the number
 * of samples read. This function is less efficient than
 * av_buffersink_get_frame(), because it copies the data around.
 *
 * @param ctx pointer to a context of the abuffersink AVFilter.
 * @param frame pointer to an allocated frame that will be filled with data.
 *              The data must be freed using av_frame_unref() / av_frame_free()
 *              frame will contain exactly nb_samples audio samples, except at
 *              the end of stream, when it can contain less than nb_samples.
 *
 * @return The return codes have the same meaning as for
 *         av_buffersink_get_frame().
 *
 * @warning do not mix this function with av_buffersink_get_frame(). Use only one or
 * the other with a single sink, not both.
 */
int av_buffersink_get_samples(AVFilterContext *ctx, AVFrame *frame, int nb_samples);

/**
 * @}
 */

#endif /* AVFILTER_BUFFERSINK_H */
