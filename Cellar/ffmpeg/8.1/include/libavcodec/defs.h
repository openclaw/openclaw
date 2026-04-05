/*
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

#ifndef AVCODEC_DEFS_H
#define AVCODEC_DEFS_H

/**
 * @file
 * @ingroup libavc
 * Misc types and constants that do not belong anywhere else.
 */

#include <stdint.h>
#include <stdlib.h>

/**
 * @ingroup lavc_decoding
 * Required number of additionally allocated bytes at the end of the input bitstream for decoding.
 * This is mainly needed because some optimized bitstream readers read
 * 32 or 64 bit at once and could read over the end.<br>
 * Note: If the first 23 bits of the additional bytes are not 0, then damaged
 * MPEG bitstreams could cause overread and segfault.
 */
#define AV_INPUT_BUFFER_PADDING_SIZE 64

/**
 * Verify checksums embedded in the bitstream (could be of either encoded or
 * decoded data, depending on the format) and print an error message on mismatch.
 * If AV_EF_EXPLODE is also set, a mismatching checksum will result in the
 * decoder/demuxer returning an error.
 */
#define AV_EF_CRCCHECK       (1<<0)
#define AV_EF_BITSTREAM      (1<<1)   ///< detect bitstream specification deviations
#define AV_EF_BUFFER         (1<<2)   ///< detect improper bitstream length
#define AV_EF_EXPLODE        (1<<3)   ///< abort decoding on minor error detection

#define AV_EF_IGNORE_ERR     (1<<15)  ///< ignore errors and continue
#define AV_EF_CAREFUL        (1<<16)  ///< consider things that violate the spec, are fast to calculate and have not been seen in the wild as errors
#define AV_EF_COMPLIANT      (1<<17)  ///< consider all spec non compliances as errors
#define AV_EF_AGGRESSIVE     (1<<18)  ///< consider things that a sane encoder/muxer should not do as an error

#define FF_COMPLIANCE_VERY_STRICT   2 ///< Strictly conform to an older more strict version of the spec or reference software.
#define FF_COMPLIANCE_STRICT        1 ///< Strictly conform to all the things in the spec no matter what consequences.
#define FF_COMPLIANCE_NORMAL        0
#define FF_COMPLIANCE_UNOFFICIAL   -1 ///< Allow unofficial extensions
#define FF_COMPLIANCE_EXPERIMENTAL -2 ///< Allow nonstandardized experimental things.


#define AV_PROFILE_UNKNOWN        -99
#define AV_PROFILE_RESERVED      -100

#define AV_PROFILE_AAC_MAIN         0
#define AV_PROFILE_AAC_LOW          1
#define AV_PROFILE_AAC_SSR          2
#define AV_PROFILE_AAC_LTP          3
#define AV_PROFILE_AAC_HE           4
#define AV_PROFILE_AAC_HE_V2       28
#define AV_PROFILE_AAC_LD          22
#define AV_PROFILE_AAC_ELD         38
#define AV_PROFILE_AAC_USAC        41
#define AV_PROFILE_MPEG2_AAC_LOW  128
#define AV_PROFILE_MPEG2_AAC_HE   131

#define AV_PROFILE_DNXHD         0
#define AV_PROFILE_DNXHR_LB      1
#define AV_PROFILE_DNXHR_SQ      2
#define AV_PROFILE_DNXHR_HQ      3
#define AV_PROFILE_DNXHR_HQX     4
#define AV_PROFILE_DNXHR_444     5

#define AV_PROFILE_DTS                20
#define AV_PROFILE_DTS_ES             30
#define AV_PROFILE_DTS_96_24          40
#define AV_PROFILE_DTS_HD_HRA         50
#define AV_PROFILE_DTS_HD_MA          60
#define AV_PROFILE_DTS_EXPRESS        70
#define AV_PROFILE_DTS_HD_MA_X        61
#define AV_PROFILE_DTS_HD_MA_X_IMAX   62

#define AV_PROFILE_EAC3_DDP_ATMOS         30

#define AV_PROFILE_TRUEHD_ATMOS           30

#define AV_PROFILE_MPEG2_422           0
#define AV_PROFILE_MPEG2_HIGH          1
#define AV_PROFILE_MPEG2_SS            2
#define AV_PROFILE_MPEG2_SNR_SCALABLE  3
#define AV_PROFILE_MPEG2_MAIN          4
#define AV_PROFILE_MPEG2_SIMPLE        5

#define AV_PROFILE_H264_CONSTRAINED  (1<<9)  // 8+1; constraint_set1_flag
#define AV_PROFILE_H264_INTRA        (1<<11) // 8+3; constraint_set3_flag

#define AV_PROFILE_H264_BASELINE             66
#define AV_PROFILE_H264_CONSTRAINED_BASELINE (66|AV_PROFILE_H264_CONSTRAINED)
#define AV_PROFILE_H264_MAIN                 77
#define AV_PROFILE_H264_EXTENDED             88
#define AV_PROFILE_H264_HIGH                 100
#define AV_PROFILE_H264_HIGH_10              110
#define AV_PROFILE_H264_HIGH_10_INTRA        (110|AV_PROFILE_H264_INTRA)
#define AV_PROFILE_H264_MULTIVIEW_HIGH       118
#define AV_PROFILE_H264_HIGH_422             122
#define AV_PROFILE_H264_HIGH_422_INTRA       (122|AV_PROFILE_H264_INTRA)
#define AV_PROFILE_H264_STEREO_HIGH          128
#define AV_PROFILE_H264_HIGH_444             144
#define AV_PROFILE_H264_HIGH_444_PREDICTIVE  244
#define AV_PROFILE_H264_HIGH_444_INTRA       (244|AV_PROFILE_H264_INTRA)
#define AV_PROFILE_H264_CAVLC_444            44

#define AV_PROFILE_VC1_SIMPLE   0
#define AV_PROFILE_VC1_MAIN     1
#define AV_PROFILE_VC1_COMPLEX  2
#define AV_PROFILE_VC1_ADVANCED 3

#define AV_PROFILE_MPEG4_SIMPLE                     0
#define AV_PROFILE_MPEG4_SIMPLE_SCALABLE            1
#define AV_PROFILE_MPEG4_CORE                       2
#define AV_PROFILE_MPEG4_MAIN                       3
#define AV_PROFILE_MPEG4_N_BIT                      4
#define AV_PROFILE_MPEG4_SCALABLE_TEXTURE           5
#define AV_PROFILE_MPEG4_SIMPLE_FACE_ANIMATION      6
#define AV_PROFILE_MPEG4_BASIC_ANIMATED_TEXTURE     7
#define AV_PROFILE_MPEG4_HYBRID                     8
#define AV_PROFILE_MPEG4_ADVANCED_REAL_TIME         9
#define AV_PROFILE_MPEG4_CORE_SCALABLE             10
#define AV_PROFILE_MPEG4_ADVANCED_CODING           11
#define AV_PROFILE_MPEG4_ADVANCED_CORE             12
#define AV_PROFILE_MPEG4_ADVANCED_SCALABLE_TEXTURE 13
#define AV_PROFILE_MPEG4_SIMPLE_STUDIO             14
#define AV_PROFILE_MPEG4_ADVANCED_SIMPLE           15

#define AV_PROFILE_JPEG2000_CSTREAM_RESTRICTION_0   1
#define AV_PROFILE_JPEG2000_CSTREAM_RESTRICTION_1   2
#define AV_PROFILE_JPEG2000_CSTREAM_NO_RESTRICTION  32768
#define AV_PROFILE_JPEG2000_DCINEMA_2K              3
#define AV_PROFILE_JPEG2000_DCINEMA_4K              4

#define AV_PROFILE_VP9_0                            0
#define AV_PROFILE_VP9_1                            1
#define AV_PROFILE_VP9_2                            2
#define AV_PROFILE_VP9_3                            3

#define AV_PROFILE_HEVC_MAIN                        1
#define AV_PROFILE_HEVC_MAIN_10                     2
#define AV_PROFILE_HEVC_MAIN_STILL_PICTURE          3
#define AV_PROFILE_HEVC_REXT                        4
#define AV_PROFILE_HEVC_MULTIVIEW_MAIN              6
#define AV_PROFILE_HEVC_SCC                         9

#define AV_PROFILE_VVC_MAIN_10                      1
#define AV_PROFILE_VVC_MAIN_10_444                 33

#define AV_PROFILE_AV1_MAIN                         0
#define AV_PROFILE_AV1_HIGH                         1
#define AV_PROFILE_AV1_PROFESSIONAL                 2

#define AV_PROFILE_MJPEG_HUFFMAN_BASELINE_DCT            0xc0
#define AV_PROFILE_MJPEG_HUFFMAN_EXTENDED_SEQUENTIAL_DCT 0xc1
#define AV_PROFILE_MJPEG_HUFFMAN_PROGRESSIVE_DCT         0xc2
#define AV_PROFILE_MJPEG_HUFFMAN_LOSSLESS                0xc3
#define AV_PROFILE_MJPEG_JPEG_LS                         0xf7

#define AV_PROFILE_SBC_MSBC                         1

#define AV_PROFILE_PRORES_PROXY     0
#define AV_PROFILE_PRORES_LT        1
#define AV_PROFILE_PRORES_STANDARD  2
#define AV_PROFILE_PRORES_HQ        3
#define AV_PROFILE_PRORES_4444      4
#define AV_PROFILE_PRORES_XQ        5

#define AV_PROFILE_PRORES_RAW       0
#define AV_PROFILE_PRORES_RAW_HQ    1

#define AV_PROFILE_ARIB_PROFILE_A 0
#define AV_PROFILE_ARIB_PROFILE_C 1

#define AV_PROFILE_KLVA_SYNC  0
#define AV_PROFILE_KLVA_ASYNC 1

#define AV_PROFILE_EVC_BASELINE             0
#define AV_PROFILE_EVC_MAIN                 1

#define AV_PROFILE_APV_422_10  33
#define AV_PROFILE_APV_422_12  44
#define AV_PROFILE_APV_444_10  55
#define AV_PROFILE_APV_444_12  66
#define AV_PROFILE_APV_4444_10 77
#define AV_PROFILE_APV_4444_12 88
#define AV_PROFILE_APV_400_10  99


#define AV_LEVEL_UNKNOWN                  -99

enum AVFieldOrder {
    AV_FIELD_UNKNOWN,
    AV_FIELD_PROGRESSIVE,
    AV_FIELD_TT,          ///< Top coded_first, top displayed first
    AV_FIELD_BB,          ///< Bottom coded first, bottom displayed first
    AV_FIELD_TB,          ///< Top coded first, bottom displayed first
    AV_FIELD_BT,          ///< Bottom coded first, top displayed first
};

/**
 * @ingroup lavc_decoding
 */
enum AVDiscard{
    /* We leave some space between them for extensions (drop some
     * keyframes for intra-only or drop just some bidir frames). */
    AVDISCARD_NONE    =-16, ///< discard nothing
    AVDISCARD_DEFAULT =  0, ///< discard useless packets like 0 size packets in avi
    AVDISCARD_NONREF  =  8, ///< discard all non reference
    AVDISCARD_BIDIR   = 16, ///< discard all bidirectional frames
    AVDISCARD_NONINTRA= 24, ///< discard all non intra frames
    AVDISCARD_NONKEY  = 32, ///< discard all frames except keyframes
    AVDISCARD_ALL     = 48, ///< discard all
};

enum AVAudioServiceType {
    AV_AUDIO_SERVICE_TYPE_MAIN              = 0,
    AV_AUDIO_SERVICE_TYPE_EFFECTS           = 1,
    AV_AUDIO_SERVICE_TYPE_VISUALLY_IMPAIRED = 2,
    AV_AUDIO_SERVICE_TYPE_HEARING_IMPAIRED  = 3,
    AV_AUDIO_SERVICE_TYPE_DIALOGUE          = 4,
    AV_AUDIO_SERVICE_TYPE_COMMENTARY        = 5,
    AV_AUDIO_SERVICE_TYPE_EMERGENCY         = 6,
    AV_AUDIO_SERVICE_TYPE_VOICE_OVER        = 7,
    AV_AUDIO_SERVICE_TYPE_KARAOKE           = 8,
    AV_AUDIO_SERVICE_TYPE_NB                   , ///< Not part of ABI
};

/**
 * Pan Scan area.
 * This specifies the area which should be displayed.
 * Note there may be multiple such areas for one frame.
 */
typedef struct AVPanScan {
    /**
     * id
     * - encoding: Set by user.
     * - decoding: Set by libavcodec.
     */
    int id;

    /**
     * width and height in 1/16 pel
     * - encoding: Set by user.
     * - decoding: Set by libavcodec.
     */
    int width;
    int height;

    /**
     * position of the top left corner in 1/16 pel for up to 3 fields/frames
     * - encoding: Set by user.
     * - decoding: Set by libavcodec.
     */
    int16_t position[3][2];
} AVPanScan;

/**
 * This structure describes the bitrate properties of an encoded bitstream. It
 * roughly corresponds to a subset the VBV parameters for MPEG-2 or HRD
 * parameters for H.264/HEVC.
 */
typedef struct AVCPBProperties {
    /**
     * Maximum bitrate of the stream, in bits per second.
     * Zero if unknown or unspecified.
     */
    int64_t max_bitrate;
    /**
     * Minimum bitrate of the stream, in bits per second.
     * Zero if unknown or unspecified.
     */
    int64_t min_bitrate;
    /**
     * Average bitrate of the stream, in bits per second.
     * Zero if unknown or unspecified.
     */
    int64_t avg_bitrate;

    /**
     * The size of the buffer to which the ratecontrol is applied, in bits.
     * Zero if unknown or unspecified.
     */
    int64_t buffer_size;

    /**
     * The delay between the time the packet this structure is associated with
     * is received and the time when it should be decoded, in periods of a 27MHz
     * clock.
     *
     * UINT64_MAX when unknown or unspecified.
     */
    uint64_t vbv_delay;
} AVCPBProperties;

/**
 * Allocate a CPB properties structure and initialize its fields to default
 * values.
 *
 * @param size if non-NULL, the size of the allocated struct will be written
 *             here. This is useful for embedding it in side data.
 *
 * @return the newly allocated struct or NULL on failure
 */
AVCPBProperties *av_cpb_properties_alloc(size_t *size);

/**
 * This structure supplies correlation between a packet timestamp and a wall clock
 * production time. The definition follows the Producer Reference Time ('prft')
 * as defined in ISO/IEC 14496-12
 */
typedef struct AVProducerReferenceTime {
    /**
     * A UTC timestamp, in microseconds, since Unix epoch (e.g, av_gettime()).
     */
    int64_t wallclock;
    int flags;
} AVProducerReferenceTime;

/**
 * RTCP SR (Sender Report) information
 *
 * The received sender report information for an RTSP
 * stream, exposed as AV_PKT_DATA_RTCP_SR side data.
 */
typedef struct AVRTCPSenderReport {
    uint32_t ssrc; ///< Synchronization source identifier
    uint64_t ntp_timestamp; ///< NTP time when the report was sent
    uint32_t rtp_timestamp; ///< RTP time when the report was sent
    uint32_t sender_nb_packets; ///< Total number of packets sent
    uint32_t sender_nb_bytes; ///< Total number of bytes sent (excluding headers or padding)
} AVRTCPSenderReport;

/**
 * Encode extradata length to a buffer. Used by xiph codecs.
 *
 * @param s buffer to write to; must be at least (v/255+1) bytes long
 * @param v size of extradata in bytes
 * @return number of bytes written to the buffer.
 */
unsigned int av_xiphlacing(unsigned char *s, unsigned int v);

#endif // AVCODEC_DEFS_H
