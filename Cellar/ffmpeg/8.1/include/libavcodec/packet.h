/*
 * AVPacket public API
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

#ifndef AVCODEC_PACKET_H
#define AVCODEC_PACKET_H

#include <stddef.h>
#include <stdint.h>

#include "libavutil/attributes.h"
#include "libavutil/buffer.h"
#include "libavutil/dict.h"
#include "libavutil/rational.h"
#include "libavutil/version.h"

#include "libavcodec/version_major.h"

/**
 * @defgroup lavc_packet_side_data AVPacketSideData
 *
 * Types and functions for working with AVPacketSideData.
 * @{
 */
enum AVPacketSideDataType {
    /**
     * An AV_PKT_DATA_PALETTE side data packet contains exactly AVPALETTE_SIZE
     * bytes worth of palette. This side data signals that a new palette is
     * present.
     */
    AV_PKT_DATA_PALETTE,

    /**
     * The AV_PKT_DATA_NEW_EXTRADATA is used to notify the codec or the format
     * that the extradata buffer was changed and the receiving side should
     * act upon it appropriately. The new extradata is embedded in the side
     * data buffer and should be immediately used for processing the current
     * frame or packet.
     */
    AV_PKT_DATA_NEW_EXTRADATA,

    /**
     * An AV_PKT_DATA_PARAM_CHANGE side data packet is laid out as follows:
     * @code
     * u32le param_flags
     * if (param_flags & AV_SIDE_DATA_PARAM_CHANGE_SAMPLE_RATE)
     *     s32le sample_rate
     * if (param_flags & AV_SIDE_DATA_PARAM_CHANGE_DIMENSIONS)
     *     s32le width
     *     s32le height
     * @endcode
     */
    AV_PKT_DATA_PARAM_CHANGE,

    /**
     * An AV_PKT_DATA_H263_MB_INFO side data packet contains a number of
     * structures with info about macroblocks relevant to splitting the
     * packet into smaller packets on macroblock edges (e.g. as for RFC 2190).
     * That is, it does not necessarily contain info about all macroblocks,
     * as long as the distance between macroblocks in the info is smaller
     * than the target payload size.
     * Each MB info structure is 12 bytes, and is laid out as follows:
     * @code
     * u32le bit offset from the start of the packet
     * u8    current quantizer at the start of the macroblock
     * u8    GOB number
     * u16le macroblock address within the GOB
     * u8    horizontal MV predictor
     * u8    vertical MV predictor
     * u8    horizontal MV predictor for block number 3
     * u8    vertical MV predictor for block number 3
     * @endcode
     */
    AV_PKT_DATA_H263_MB_INFO,

    /**
     * This side data should be associated with an audio stream and contains
     * ReplayGain information in form of the AVReplayGain struct.
     */
    AV_PKT_DATA_REPLAYGAIN,

    /**
     * This side data contains a 3x3 transformation matrix describing an affine
     * transformation that needs to be applied to the decoded video frames for
     * correct presentation.
     *
     * See libavutil/display.h for a detailed description of the data.
     */
    AV_PKT_DATA_DISPLAYMATRIX,

    /**
     * This side data should be associated with a video stream and contains
     * Stereoscopic 3D information in form of the AVStereo3D struct.
     */
    AV_PKT_DATA_STEREO3D,

    /**
     * This side data should be associated with an audio stream and corresponds
     * to enum AVAudioServiceType.
     */
    AV_PKT_DATA_AUDIO_SERVICE_TYPE,

    /**
     * This side data contains quality related information from the encoder.
     * @code
     * u32le quality factor of the compressed frame. Allowed range is between 1 (good) and FF_LAMBDA_MAX (bad).
     * u8    picture type
     * u8    error count
     * u16   reserved
     * u64le[error count] sum of squared differences between encoder in and output
     * @endcode
     */
    AV_PKT_DATA_QUALITY_STATS,

    /**
     * This side data contains an integer value representing the stream index
     * of a "fallback" track.  A fallback track indicates an alternate
     * track to use when the current track can not be decoded for some reason.
     * e.g. no decoder available for codec.
     */
    AV_PKT_DATA_FALLBACK_TRACK,

    /**
     * This side data corresponds to the AVCPBProperties struct.
     */
    AV_PKT_DATA_CPB_PROPERTIES,

    /**
     * Recommends skipping the specified number of samples
     * @code
     * u32le number of samples to skip from start of this packet
     * u32le number of samples to skip from end of this packet
     * u8    reason for start skip
     * u8    reason for end   skip (0=padding silence, 1=convergence)
     * @endcode
     */
    AV_PKT_DATA_SKIP_SAMPLES,

    /**
     * An AV_PKT_DATA_JP_DUALMONO side data packet indicates that
     * the packet may contain "dual mono" audio specific to Japanese DTV
     * and if it is true, recommends only the selected channel to be used.
     * @code
     * u8    selected channels (0=main/left, 1=sub/right, 2=both)
     * @endcode
     */
    AV_PKT_DATA_JP_DUALMONO,

    /**
     * A list of zero terminated key/value strings. There is no end marker for
     * the list, so it is required to rely on the side data size to stop.
     */
    AV_PKT_DATA_STRINGS_METADATA,

    /**
     * Subtitle event position
     * @code
     * u32le x1
     * u32le y1
     * u32le x2
     * u32le y2
     * @endcode
     */
    AV_PKT_DATA_SUBTITLE_POSITION,

    /**
     * Data found in BlockAdditional element of matroska container. There is
     * no end marker for the data, so it is required to rely on the side data
     * size to recognize the end. 8 byte id (as found in BlockAddId) followed
     * by data.
     */
    AV_PKT_DATA_MATROSKA_BLOCKADDITIONAL,

    /**
     * The optional first identifier line of a WebVTT cue.
     */
    AV_PKT_DATA_WEBVTT_IDENTIFIER,

    /**
     * The optional settings (rendering instructions) that immediately
     * follow the timestamp specifier of a WebVTT cue.
     */
    AV_PKT_DATA_WEBVTT_SETTINGS,

    /**
     * A list of zero terminated key/value strings. There is no end marker for
     * the list, so it is required to rely on the side data size to stop. This
     * side data includes updated metadata which appeared in the stream.
     */
    AV_PKT_DATA_METADATA_UPDATE,

    /**
     * MPEGTS stream ID as uint8_t, this is required to pass the stream ID
     * information from the demuxer to the corresponding muxer.
     */
    AV_PKT_DATA_MPEGTS_STREAM_ID,

    /**
     * Mastering display metadata (based on SMPTE-2086:2014). This metadata
     * should be associated with a video stream and contains data in the form
     * of the AVMasteringDisplayMetadata struct.
     */
    AV_PKT_DATA_MASTERING_DISPLAY_METADATA,

    /**
     * This side data should be associated with a video stream and corresponds
     * to the AVSphericalMapping structure.
     */
    AV_PKT_DATA_SPHERICAL,

    /**
     * Content light level (based on CTA-861.3). This metadata should be
     * associated with a video stream and contains data in the form of the
     * AVContentLightMetadata struct.
     */
    AV_PKT_DATA_CONTENT_LIGHT_LEVEL,

    /**
     * ATSC A53 Part 4 Closed Captions. This metadata should be associated with
     * a video stream. A53 CC bitstream is stored as uint8_t in AVPacketSideData.data.
     * The number of bytes of CC data is AVPacketSideData.size.
     */
    AV_PKT_DATA_A53_CC,

    /**
     * This side data is encryption initialization data.
     * The format is not part of ABI, use av_encryption_init_info_* methods to
     * access.
     */
    AV_PKT_DATA_ENCRYPTION_INIT_INFO,

    /**
     * This side data contains encryption info for how to decrypt the packet.
     * The format is not part of ABI, use av_encryption_info_* methods to access.
     */
    AV_PKT_DATA_ENCRYPTION_INFO,

    /**
     * Active Format Description data consisting of a single byte as specified
     * in ETSI TS 101 154 using AVActiveFormatDescription enum.
     */
    AV_PKT_DATA_AFD,

    /**
     * Producer Reference Time data corresponding to the AVProducerReferenceTime struct,
     * usually exported by some encoders (on demand through the prft flag set in the
     * AVCodecContext export_side_data field).
     */
    AV_PKT_DATA_PRFT,

    /**
     * ICC profile data consisting of an opaque octet buffer following the
     * format described by ISO 15076-1.
     */
    AV_PKT_DATA_ICC_PROFILE,

    /**
     * DOVI configuration
     * ref:
     * dolby-vision-bitstreams-within-the-iso-base-media-file-format-v2.1.2, section 2.2
     * dolby-vision-bitstreams-in-mpeg-2-transport-stream-multiplex-v1.2, section 3.3
     * Tags are stored in struct AVDOVIDecoderConfigurationRecord.
     */
    AV_PKT_DATA_DOVI_CONF,

    /**
     * Timecode which conforms to SMPTE ST 12-1:2014. The data is an array of 4 uint32_t
     * where the first uint32_t describes how many (1-3) of the other timecodes are used.
     * The timecode format is described in the documentation of av_timecode_get_smpte_from_framenum()
     * function in libavutil/timecode.h.
     */
    AV_PKT_DATA_S12M_TIMECODE,

    /**
     * HDR10+ dynamic metadata associated with a video frame. The metadata is in
     * the form of the AVDynamicHDRPlus struct and contains
     * information for color volume transform - application 4 of
     * SMPTE 2094-40:2016 standard.
     */
    AV_PKT_DATA_DYNAMIC_HDR10_PLUS,

    /**
     * IAMF Mix Gain Parameter Data associated with the audio frame. This metadata
     * is in the form of the AVIAMFParamDefinition struct and contains information
     * defined in sections 3.6.1 and 3.8.1 of the Immersive Audio Model and
     * Formats standard.
     */
    AV_PKT_DATA_IAMF_MIX_GAIN_PARAM,

    /**
     * IAMF Demixing Info Parameter Data associated with the audio frame. This
     * metadata is in the form of the AVIAMFParamDefinition struct and contains
     * information defined in sections 3.6.1 and 3.8.2 of the Immersive Audio Model
     * and Formats standard.
     */
    AV_PKT_DATA_IAMF_DEMIXING_INFO_PARAM,

    /**
     * IAMF Recon Gain Info Parameter Data associated with the audio frame. This
     * metadata is in the form of the AVIAMFParamDefinition struct and contains
     * information defined in sections 3.6.1 and 3.8.3 of the Immersive Audio Model
     * and Formats standard.
     */
    AV_PKT_DATA_IAMF_RECON_GAIN_INFO_PARAM,

    /**
     * Ambient viewing environment metadata, as defined by H.274. This metadata
     * should be associated with a video stream and contains data in the form
     * of the AVAmbientViewingEnvironment struct.
    */
    AV_PKT_DATA_AMBIENT_VIEWING_ENVIRONMENT,

    /**
     * The number of pixels to discard from the top/bottom/left/right border of the
     * decoded frame to obtain the sub-rectangle intended for presentation.
     *
     * @code
     * u32le crop_top
     * u32le crop_bottom
     * u32le crop_left
     * u32le crop_right
     * @endcode
     */
    AV_PKT_DATA_FRAME_CROPPING,

    /**
     * Raw LCEVC payload data, as a uint8_t array, with NAL emulation
     * bytes intact.
     */
    AV_PKT_DATA_LCEVC,

    /**
     * This side data contains information about the reference display width(s)
     * and reference viewing distance(s) as well as information about the
     * corresponding reference stereo pair(s), i.e., the pair(s) of views to be
     * displayed for the viewer's left and right eyes on the reference display
     * at the reference viewing distance.
     * The payload is the AV3DReferenceDisplaysInfo struct defined in
     * libavutil/tdrdi.h.
     */
    AV_PKT_DATA_3D_REFERENCE_DISPLAYS,

    /**
     * Contains the last received RTCP SR (Sender Report) information
     * in the form of the AVRTCPSenderReport struct.
     */
    AV_PKT_DATA_RTCP_SR,

    /**
     * Extensible image file format metadata. The payload is a buffer containing
     * EXIF metadata, starting with either 49 49 2a 00, or 4d 4d 00 2a.
     */
     AV_PKT_DATA_EXIF,

    /**
     * The number of side data types.
     * This is not part of the public API/ABI in the sense that it may
     * change when new side data types are added.
     * This must stay the last enum value.
     * If its value becomes huge, some code using it
     * needs to be updated as it assumes it to be smaller than other limits.
     */
    AV_PKT_DATA_NB
};

/**
 * This structure stores auxiliary information for decoding, presenting, or
 * otherwise processing the coded stream. It is typically exported by demuxers
 * and encoders and can be fed to decoders and muxers either in a per packet
 * basis, or as global side data (applying to the entire coded stream).
 *
 * Global side data is handled as follows:
 * - During demuxing, it may be exported through
 *   @ref AVCodecParameters.coded_side_data "AVStream's codec parameters", which can
 *   then be passed as input to decoders through the
 *   @ref AVCodecContext.coded_side_data "decoder context's side data", for
 *   initialization.
 * - For muxing, it can be fed through @ref AVCodecParameters.coded_side_data
 *   "AVStream's codec parameters", typically  the output of encoders through
 *   the @ref AVCodecContext.coded_side_data "encoder context's side data", for
 *   initialization.
 *
 * Packet specific side data is handled as follows:
 * - During demuxing, it may be exported through @ref AVPacket.side_data
 *   "AVPacket's side data", which can then be passed as input to decoders.
 * - For muxing, it can be fed through @ref AVPacket.side_data "AVPacket's
 *   side data", typically the output of encoders.
 *
 * Different modules may accept or export different types of side data
 * depending on media type and codec. Refer to @ref AVPacketSideDataType for a
 * list of defined types and where they may be found or used.
 */
typedef struct AVPacketSideData {
    uint8_t *data;
    size_t   size;
    enum AVPacketSideDataType type;
} AVPacketSideData;

/**
 * Allocate a new packet side data.
 *
 * @param sd    pointer to an array of side data to which the side data should
 *              be added. *sd may be NULL, in which case the array will be
 *              initialized.
 * @param nb_sd pointer to an integer containing the number of entries in
 *              the array. The integer value will be increased by 1 on success.
 * @param type  side data type
 * @param size  desired side data size
 * @param flags currently unused. Must be zero
 *
 * @return pointer to freshly allocated side data on success, or NULL otherwise.
 */
AVPacketSideData *av_packet_side_data_new(AVPacketSideData **psd, int *pnb_sd,
                                          enum AVPacketSideDataType type,
                                          size_t size, int flags);

/**
 * Wrap existing data as packet side data.
 *
 * @param sd    pointer to an array of side data to which the side data should
 *              be added. *sd may be NULL, in which case the array will be
 *              initialized
 * @param nb_sd pointer to an integer containing the number of entries in
 *              the array. The integer value will be increased by 1 on success.
 * @param type  side data type
 * @param data  a data array. It must be allocated with the av_malloc() family
 *              of functions. The ownership of the data is transferred to the
 *              side data array on success
 * @param size  size of the data array
 * @param flags currently unused. Must be zero
 *
 * @return pointer to freshly allocated side data on success, or NULL otherwise
 *         On failure, the side data array is unchanged and the data remains
 *         owned by the caller.
 */
AVPacketSideData *av_packet_side_data_add(AVPacketSideData **sd, int *nb_sd,
                                          enum AVPacketSideDataType type,
                                          void *data, size_t size, int flags);

/**
 * Get side information from a side data array.
 *
 * @param sd    the array from which the side data should be fetched
 * @param nb_sd value containing the number of entries in the array.
 * @param type  desired side information type
 *
 * @return pointer to side data if present or NULL otherwise
 */
const AVPacketSideData *av_packet_side_data_get(const AVPacketSideData *sd,
                                                int nb_sd,
                                                enum AVPacketSideDataType type);

/**
 * Remove side data of the given type from a side data array.
 *
 * @param sd    the array from which the side data should be removed
 * @param nb_sd pointer to an integer containing the number of entries in
 *              the array. Will be reduced by the amount of entries removed
 *              upon return
 * @param type  side information type
 */
void av_packet_side_data_remove(AVPacketSideData *sd, int *nb_sd,
                                enum AVPacketSideDataType type);

/**
 * Convenience function to free all the side data stored in an array, and
 * the array itself.
 *
 * @param sd    pointer to array of side data to free. Will be set to NULL
 *              upon return.
 * @param nb_sd pointer to an integer containing the number of entries in
 *              the array. Will be set to 0 upon return.
 */
void av_packet_side_data_free(AVPacketSideData **sd, int *nb_sd);

struct AVFrameSideData;

/**
 * Add a new packet side data entry to an array based on existing frame
 * side data, if a matching type exists for packet side data.
 *
 * @param flags              Currently unused. Must be 0.
 * @retval >= 0              Success
 * @retval AVERROR(EINVAL)   The frame side data type does not have a matching
 *                           packet side data type.
 * @retval AVERROR(ENOMEM)   Failed to add a side data entry to the array, or
 *                           similar.
 */
int av_packet_side_data_from_frame(AVPacketSideData **sd, int *nb_sd,
                                   const struct AVFrameSideData *src, unsigned int flags);
/**
 * Add a new frame side data entry to an array based on existing packet
 * side data, if a matching type exists for frame side data.
 *
 * @param flags              Some combination of AV_FRAME_SIDE_DATA_FLAG_* flags,
 *                           or 0.
 * @retval >= 0              Success
 * @retval AVERROR(EINVAL)   The packet side data type does not have a matching
 *                           frame side data type.
 * @retval AVERROR(ENOMEM)   Failed to add a side data entry to the array, or
 *                           similar.
 */
int av_packet_side_data_to_frame(struct AVFrameSideData ***sd, int *nb_sd,
                                 const AVPacketSideData *src, unsigned int flags);

const char *av_packet_side_data_name(enum AVPacketSideDataType type);

/**
 * @}
 */

/**
 * @defgroup lavc_packet AVPacket
 *
 * Types and functions for working with AVPacket.
 * @{
 */

/**
 * This structure stores compressed data. It is typically exported by demuxers
 * and then passed as input to decoders, or received as output from encoders and
 * then passed to muxers.
 *
 * For video, it should typically contain one compressed frame. For audio it may
 * contain several compressed frames. Encoders are allowed to output empty
 * packets, with no compressed data, containing only side data
 * (e.g. to update some stream parameters at the end of encoding).
 *
 * The semantics of data ownership depends on the buf field.
 * If it is set, the packet data is dynamically allocated and is
 * valid indefinitely until a call to av_packet_unref() reduces the
 * reference count to 0.
 *
 * If the buf field is not set av_packet_ref() would make a copy instead
 * of increasing the reference count.
 *
 * The side data is always allocated with av_malloc(), copied by
 * av_packet_ref() and freed by av_packet_unref().
 *
 * sizeof(AVPacket) being a part of the public ABI is deprecated. once
 * av_init_packet() is removed, new packets will only be able to be allocated
 * with av_packet_alloc(), and new fields may be added to the end of the struct
 * with a minor bump.
 *
 * @see av_packet_alloc
 * @see av_packet_ref
 * @see av_packet_unref
 */
typedef struct AVPacket {
    /**
     * A reference to the reference-counted buffer where the packet data is
     * stored.
     * May be NULL, then the packet data is not reference-counted.
     */
    AVBufferRef *buf;
    /**
     * Presentation timestamp in AVStream->time_base units; the time at which
     * the decompressed packet will be presented to the user.
     * Can be AV_NOPTS_VALUE if it is not stored in the file.
     * pts MUST be larger or equal to dts as presentation cannot happen before
     * decompression, unless one wants to view hex dumps. Some formats misuse
     * the terms dts and pts/cts to mean something different. Such timestamps
     * must be converted to true pts/dts before they are stored in AVPacket.
     */
    int64_t pts;
    /**
     * Decompression timestamp in AVStream->time_base units; the time at which
     * the packet is decompressed.
     * Can be AV_NOPTS_VALUE if it is not stored in the file.
     */
    int64_t dts;
    uint8_t *data;
    int   size;
    int   stream_index;
    /**
     * A combination of AV_PKT_FLAG values
     */
    int   flags;
    /**
     * Additional packet data that can be provided by the container.
     * Packet can contain several types of side information.
     */
    AVPacketSideData *side_data;
    int side_data_elems;

    /**
     * Duration of this packet in AVStream->time_base units, 0 if unknown.
     * Equals next_pts - this_pts in presentation order.
     */
    int64_t duration;

    int64_t pos;                            ///< byte position in stream, -1 if unknown

    /**
     * for some private data of the user
     */
    void *opaque;

    /**
     * AVBufferRef for free use by the API user. FFmpeg will never check the
     * contents of the buffer ref. FFmpeg calls av_buffer_unref() on it when
     * the packet is unreferenced. av_packet_copy_props() calls create a new
     * reference with av_buffer_ref() for the target packet's opaque_ref field.
     *
     * This is unrelated to the opaque field, although it serves a similar
     * purpose.
     */
    AVBufferRef *opaque_ref;

    /**
     * Time base of the packet's timestamps.
     * In the future, this field may be set on packets output by encoders or
     * demuxers, but its value will be by default ignored on input to decoders
     * or muxers.
     */
    AVRational time_base;
} AVPacket;

#if FF_API_INIT_PACKET
attribute_deprecated
typedef struct AVPacketList {
    AVPacket pkt;
    struct AVPacketList *next;
} AVPacketList;
#endif

#define AV_PKT_FLAG_KEY     0x0001 ///< The packet contains a keyframe
#define AV_PKT_FLAG_CORRUPT 0x0002 ///< The packet content is corrupted
/**
 * Flag is used to discard packets which are required to maintain valid
 * decoder state but are not required for output and should be dropped
 * after decoding.
 **/
#define AV_PKT_FLAG_DISCARD   0x0004
/**
 * The packet comes from a trusted source.
 *
 * Otherwise-unsafe constructs such as arbitrary pointers to data
 * outside the packet may be followed.
 */
#define AV_PKT_FLAG_TRUSTED   0x0008
/**
 * Flag is used to indicate packets that contain frames that can
 * be discarded by the decoder.  I.e. Non-reference frames.
 */
#define AV_PKT_FLAG_DISPOSABLE 0x0010

enum AVSideDataParamChangeFlags {
    AV_SIDE_DATA_PARAM_CHANGE_SAMPLE_RATE    = 0x0004,
    AV_SIDE_DATA_PARAM_CHANGE_DIMENSIONS     = 0x0008,
};

/**
 * Allocate an AVPacket and set its fields to default values.  The resulting
 * struct must be freed using av_packet_free().
 *
 * @return An AVPacket filled with default values or NULL on failure.
 *
 * @note this only allocates the AVPacket itself, not the data buffers. Those
 * must be allocated through other means such as av_new_packet.
 *
 * @see av_new_packet
 */
AVPacket *av_packet_alloc(void);

/**
 * Create a new packet that references the same data as src.
 *
 * This is a shortcut for av_packet_alloc()+av_packet_ref().
 *
 * @return newly created AVPacket on success, NULL on error.
 *
 * @see av_packet_alloc
 * @see av_packet_ref
 */
AVPacket *av_packet_clone(const AVPacket *src);

/**
 * Free the packet, if the packet is reference counted, it will be
 * unreferenced first.
 *
 * @param pkt packet to be freed. The pointer will be set to NULL.
 * @note passing NULL is a no-op.
 */
void av_packet_free(AVPacket **pkt);

#if FF_API_INIT_PACKET
/**
 * Initialize optional fields of a packet with default values.
 *
 * Note, this does not touch the data and size members, which have to be
 * initialized separately.
 *
 * @param pkt packet
 *
 * @see av_packet_alloc
 * @see av_packet_unref
 *
 * @deprecated This function is deprecated. Once it's removed,
               sizeof(AVPacket) will not be a part of the ABI anymore.
 */
attribute_deprecated
void av_init_packet(AVPacket *pkt);
#endif

/**
 * Allocate the payload of a packet and initialize its fields with
 * default values.
 *
 * @param pkt packet
 * @param size wanted payload size
 * @return 0 if OK, AVERROR_xxx otherwise
 */
int av_new_packet(AVPacket *pkt, int size);

/**
 * Reduce packet size, correctly zeroing padding
 *
 * @param pkt packet
 * @param size new size
 */
void av_shrink_packet(AVPacket *pkt, int size);

/**
 * Increase packet size, correctly zeroing padding
 *
 * @param pkt packet
 * @param grow_by number of bytes by which to increase the size of the packet
 */
int av_grow_packet(AVPacket *pkt, int grow_by);

/**
 * Initialize a reference-counted packet from av_malloc()ed data.
 *
 * @param pkt packet to be initialized. This function will set the data, size,
 *        and buf fields, all others are left untouched.
 * @param data Data allocated by av_malloc() to be used as packet data. If this
 *        function returns successfully, the data is owned by the underlying AVBuffer.
 *        The caller may not access the data through other means.
 * @param size size of data in bytes, without the padding. I.e. the full buffer
 *        size is assumed to be size + AV_INPUT_BUFFER_PADDING_SIZE.
 *
 * @return 0 on success, a negative AVERROR on error
 */
int av_packet_from_data(AVPacket *pkt, uint8_t *data, int size);

/**
 * Allocate new information of a packet.
 *
 * @param pkt packet
 * @param type side information type
 * @param size side information size
 * @return pointer to fresh allocated data or NULL otherwise
 */
uint8_t* av_packet_new_side_data(AVPacket *pkt, enum AVPacketSideDataType type,
                                 size_t size);

/**
 * Wrap an existing array as a packet side data.
 *
 * @param pkt packet
 * @param type side information type
 * @param data the side data array. It must be allocated with the av_malloc()
 *             family of functions. The ownership of the data is transferred to
 *             pkt.
 * @param size side information size
 * @return a non-negative number on success, a negative AVERROR code on
 *         failure. On failure, the packet is unchanged and the data remains
 *         owned by the caller.
 */
int av_packet_add_side_data(AVPacket *pkt, enum AVPacketSideDataType type,
                            uint8_t *data, size_t size);

/**
 * Shrink the already allocated side data buffer
 *
 * @param pkt packet
 * @param type side information type
 * @param size new side information size
 * @return 0 on success, < 0 on failure
 */
int av_packet_shrink_side_data(AVPacket *pkt, enum AVPacketSideDataType type,
                               size_t size);

/**
 * Get side information from packet.
 *
 * @param pkt packet
 * @param type desired side information type
 * @param size If supplied, *size will be set to the size of the side data
 *             or to zero if the desired side data is not present.
 * @return pointer to data if present or NULL otherwise
 */
uint8_t* av_packet_get_side_data(const AVPacket *pkt, enum AVPacketSideDataType type,
                                 size_t *size);

/**
 * Pack a dictionary for use in side_data.
 *
 * @param dict The dictionary to pack.
 * @param size pointer to store the size of the returned data
 * @return pointer to data if successful, NULL otherwise
 */
uint8_t *av_packet_pack_dictionary(AVDictionary *dict, size_t *size);
/**
 * Unpack a dictionary from side_data.
 *
 * @param data data from side_data
 * @param size size of the data
 * @param dict the metadata storage dictionary
 * @return 0 on success, < 0 on failure
 */
int av_packet_unpack_dictionary(const uint8_t *data, size_t size,
                                AVDictionary **dict);

/**
 * Convenience function to free all the side data stored.
 * All the other fields stay untouched.
 *
 * @param pkt packet
 */
void av_packet_free_side_data(AVPacket *pkt);

/**
 * Setup a new reference to the data described by a given packet
 *
 * If src is reference-counted, setup dst as a new reference to the
 * buffer in src. Otherwise allocate a new buffer in dst and copy the
 * data from src into it.
 *
 * All the other fields are copied from src.
 *
 * @see av_packet_unref
 *
 * @param dst Destination packet. Will be completely overwritten.
 * @param src Source packet
 *
 * @return 0 on success, a negative AVERROR on error. On error, dst
 *         will be blank (as if returned by av_packet_alloc()).
 */
int av_packet_ref(AVPacket *dst, const AVPacket *src);

/**
 * Wipe the packet.
 *
 * Unreference the buffer referenced by the packet and reset the
 * remaining packet fields to their default values.
 *
 * @param pkt The packet to be unreferenced.
 */
void av_packet_unref(AVPacket *pkt);

/**
 * Move every field in src to dst and reset src.
 *
 * @see av_packet_unref
 *
 * @param src Source packet, will be reset
 * @param dst Destination packet
 */
void av_packet_move_ref(AVPacket *dst, AVPacket *src);

/**
 * Copy only "properties" fields from src to dst.
 *
 * Properties for the purpose of this function are all the fields
 * beside those related to the packet data (buf, data, size)
 *
 * @param dst Destination packet
 * @param src Source packet
 *
 * @return 0 on success AVERROR on failure.
 */
int av_packet_copy_props(AVPacket *dst, const AVPacket *src);

/**
 * Ensure the data described by a given packet is reference counted.
 *
 * @note This function does not ensure that the reference will be writable.
 *       Use av_packet_make_writable instead for that purpose.
 *
 * @see av_packet_ref
 * @see av_packet_make_writable
 *
 * @param pkt packet whose data should be made reference counted.
 *
 * @return 0 on success, a negative AVERROR on error. On failure, the
 *         packet is unchanged.
 */
int av_packet_make_refcounted(AVPacket *pkt);

/**
 * Create a writable reference for the data described by a given packet,
 * avoiding data copy if possible.
 *
 * @param pkt Packet whose data should be made writable.
 *
 * @return 0 on success, a negative AVERROR on failure. On failure, the
 *         packet is unchanged.
 */
int av_packet_make_writable(AVPacket *pkt);

/**
 * Convert valid timing fields (timestamps / durations) in a packet from one
 * timebase to another. Timestamps with unknown values (AV_NOPTS_VALUE) will be
 * ignored.
 *
 * @param pkt packet on which the conversion will be performed
 * @param tb_src source timebase, in which the timing fields in pkt are
 *               expressed
 * @param tb_dst destination timebase, to which the timing fields will be
 *               converted
 */
void av_packet_rescale_ts(AVPacket *pkt, AVRational tb_src, AVRational tb_dst);

/**
 * Allocate an AVContainerFifo instance for AVPacket.
 *
 * @param flags currently unused
 */
struct AVContainerFifo *av_container_fifo_alloc_avpacket(unsigned flags);

/**
 * @}
 */

#endif // AVCODEC_PACKET_H
