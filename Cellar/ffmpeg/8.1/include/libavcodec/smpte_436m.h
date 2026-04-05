/*
 * MXF SMPTE-436M VBI/ANC parsing functions
 * Copyright (c) 2025 Jacob Lifshay
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

#ifndef AVCODEC_SMPTE_436M_H
#define AVCODEC_SMPTE_436M_H

#include <stdint.h>

/**
 * Iterator over the ANC packets in a single AV_CODEC_ID_SMPTE_436M_ANC AVPacket's data
 */
typedef struct AVSmpte436mAncIterator {
    uint16_t       anc_packets_left;
    int            size_left;
    const uint8_t *data_left;
} AVSmpte436mAncIterator;

/**
 * Wrapping Type from Table 7 (page 13) of:
 * https://pub.smpte.org/latest/st436/s436m-2006.pdf
 */
typedef enum AVSmpte436mWrappingType
{
    AV_SMPTE_436M_WRAPPING_TYPE_VANC_FRAME             = 1,
    AV_SMPTE_436M_WRAPPING_TYPE_VANC_FIELD_1           = 2,
    AV_SMPTE_436M_WRAPPING_TYPE_VANC_FIELD_2           = 3,
    AV_SMPTE_436M_WRAPPING_TYPE_VANC_PROGRESSIVE_FRAME = 4,
    AV_SMPTE_436M_WRAPPING_TYPE_HANC_FRAME             = 0x11,
    AV_SMPTE_436M_WRAPPING_TYPE_HANC_FIELD_1           = 0x12,
    AV_SMPTE_436M_WRAPPING_TYPE_HANC_FIELD_2           = 0x13,
    AV_SMPTE_436M_WRAPPING_TYPE_HANC_PROGRESSIVE_FRAME = 0x14,
    /** not a real wrapping type, just here to guarantee the enum is big enough */
    AV_SMPTE_436M_WRAPPING_TYPE_MAX = 0xFF,
} AVSmpte436mWrappingType;

/**
 * Payload Sample Coding from Table 4 (page 10) and Table 7 (page 13) of:
 * https://pub.smpte.org/latest/st436/s436m-2006.pdf
 */
typedef enum AVSmpte436mPayloadSampleCoding
{
    /** only used for VBI */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_1BIT_LUMA = 1,
    /** only used for VBI */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_1BIT_COLOR_DIFF = 2,
    /** only used for VBI */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_1BIT_LUMA_AND_COLOR_DIFF = 3,
    /** used for VBI and ANC */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_8BIT_LUMA = 4,
    /** used for VBI and ANC */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_8BIT_COLOR_DIFF = 5,
    /** used for VBI and ANC */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_8BIT_LUMA_AND_COLOR_DIFF = 6,
    /** used for VBI and ANC */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_10BIT_LUMA = 7,
    /** used for VBI and ANC */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_10BIT_COLOR_DIFF = 8,
    /** used for VBI and ANC */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_10BIT_LUMA_AND_COLOR_DIFF = 9,
    /** only used for ANC */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_8BIT_LUMA_WITH_PARITY_ERROR = 10,
    /** only used for ANC */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_8BIT_COLOR_DIFF_WITH_PARITY_ERROR = 11,
    /** only used for ANC */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_8BIT_LUMA_AND_COLOR_DIFF_WITH_PARITY_ERROR = 12,
    /** not a real sample coding, just here to guarantee the enum is big enough */
    AV_SMPTE_436M_PAYLOAD_SAMPLE_CODING_MAX = 0xFF,
} AVSmpte436mPayloadSampleCoding;

/** the payload capacity of AVSmpte291mAnc8bit (and of AVSmpte291mAnc10bit when that gets added) */
#define AV_SMPTE_291M_ANC_PAYLOAD_CAPACITY 0xFF

/**
 * An ANC packet with an 8-bit payload.
 * This can be decoded from AVSmpte436mCodedAnc::payload.
 *
 * Note: Some ANC packets need a 10-bit payload, if stored in this struct,
 * the most-significant 2 bits of each sample are discarded.
 */
typedef struct AVSmpte291mAnc8bit {
    uint8_t did;
    uint8_t sdid_or_dbn;
    uint8_t data_count;
    uint8_t payload[AV_SMPTE_291M_ANC_PAYLOAD_CAPACITY];
    uint8_t checksum;
} AVSmpte291mAnc8bit;

/** max number of samples that can be stored in the payload of AVSmpte436mCodedAnc */
#define AV_SMPTE_436M_CODED_ANC_SAMPLE_CAPACITY                                                     \
    (AV_SMPTE_291M_ANC_PAYLOAD_CAPACITY + 4) /* 4 for did, sdid_or_dbn, data_count, and checksum */
/** max number of bytes that can be stored in the payload of AVSmpte436mCodedAnc */
#define AV_SMPTE_436M_CODED_ANC_PAYLOAD_CAPACITY (((AV_SMPTE_436M_CODED_ANC_SAMPLE_CAPACITY + 2) / 3) * 4)

/**
 * An encoded ANC packet within a single AV_CODEC_ID_SMPTE_436M_ANC AVPacket's data.
 * The repeated section of Table 7 (page 13) of:
 * https://pub.smpte.org/latest/st436/s436m-2006.pdf
 */
typedef struct AVSmpte436mCodedAnc {
    uint16_t                       line_number;
    AVSmpte436mWrappingType        wrapping_type;
    AVSmpte436mPayloadSampleCoding payload_sample_coding;
    uint16_t                       payload_sample_count;
    uint32_t                       payload_array_length;
    /** the payload, has size payload_array_length.
     * can be decoded into AVSmpte291mAnc8bit
     */
    uint8_t payload[AV_SMPTE_436M_CODED_ANC_PAYLOAD_CAPACITY];
} AVSmpte436mCodedAnc;

/**
 * Validate a AVSmpte436mCodedAnc structure. Doesn't check if the payload is valid.
 * @param[in]  anc ANC packet to validate
 * @return 0 on success, AVERROR codes otherwise.
 */
int av_smpte_436m_coded_anc_validate(const AVSmpte436mCodedAnc *anc);

/**
 * Encode ANC packets into a single AV_CODEC_ID_SMPTE_436M_ANC AVPacket's data.
 * @param[in]  anc_packet_count number of ANC packets to encode
 * @param[in]  anc_packets      the ANC packets to encode
 * @param[in]  size             the size of out. ignored if out is NULL.
 * @param[out] out              Output bytes. Doesn't write anything if out is NULL.
 * @return the number of bytes written on success, AVERROR codes otherwise.
 *         If out is NULL, returns the number of bytes it would have written.
 */
int av_smpte_436m_anc_encode(uint8_t *out, int size, int anc_packet_count, const AVSmpte436mCodedAnc *anc_packets);

struct AVPacket;

/**
 * Append more ANC packets to a single AV_CODEC_ID_SMPTE_436M_ANC AVPacket's data.
 * @param[in]  anc_packet_count number of ANC packets to encode
 * @param[in]  anc_packets      the ANC packets to encode
 * @param      pkt              the AVPacket to append to.
 *                              it must either be size 0 or contain valid SMPTE_436M_ANC data.
 * @return 0 on success, AVERROR codes otherwise.
 */
int av_smpte_436m_anc_append(struct AVPacket *pkt, int anc_packet_count, const AVSmpte436mCodedAnc *anc_packets);

/**
 * Set up iteration over the ANC packets in a single AV_CODEC_ID_SMPTE_436M_ANC AVPacket's data.
 * @param[in]  buf      Pointer to the data from a AV_CODEC_ID_SMPTE_436M_ANC AVPacket.
 * @param[in]  buf_size Size of the data from a AV_CODEC_ID_SMPTE_436M_ANC AVPacket.
 * @param[out] iter     Pointer to the iterator.
 * @return 0 on success, AVERROR codes otherwise.
 */
int av_smpte_436m_anc_iter_init(AVSmpte436mAncIterator *iter, const uint8_t *buf, int buf_size);

/**
 * Get the next ANC packet from the iterator, advancing the iterator.
 * @param[in,out] iter Pointer to the iterator.
 * @param[out]    anc  The returned ANC packet.
 * @return 0 on success, AVERROR_EOF when the iterator has reached the end, AVERROR codes otherwise.
 */
int av_smpte_436m_anc_iter_next(AVSmpte436mAncIterator *iter, AVSmpte436mCodedAnc *anc);

/**
 * Get the minimum number of bytes needed to store a AVSmpte436mCodedAnc payload.
 * @param sample_coding the payload sample coding
 * @param sample_count  the number of samples stored in the payload
 * @return returns the minimum number of bytes needed, on error returns < 0.
 *         always <= SMPTE_436M_CODED_ANC_PAYLOAD_CAPACITY
 */
int av_smpte_436m_coded_anc_payload_size(AVSmpte436mPayloadSampleCoding sample_coding, uint16_t sample_count);

/**
 * Decode a AVSmpte436mCodedAnc payload into AVSmpte291mAnc8bit
 * @param[in]  sample_coding the payload sample coding
 * @param[in]  sample_count  the number of samples stored in the payload
 * @param[in]  payload       the bytes storing the payload,
 *                           the needed size can be obtained from
                             avpriv_smpte_436m_coded_anc_payload_size
 * @param[in]  log_ctx       context pointer for av_log
 * @param[out] out           The decoded ANC packet.
 * @return returns 0 on success, otherwise < 0.
 */
int av_smpte_291m_anc_8bit_decode(AVSmpte291mAnc8bit            *out,
                                  AVSmpte436mPayloadSampleCoding sample_coding,
                                  uint16_t                       sample_count,
                                  const uint8_t                 *payload,
                                  void                          *log_ctx);

/**
 * Fill in the correct checksum for a AVSmpte291mAnc8bit
 * @param[in,out] anc The ANC packet.
 */
void av_smpte_291m_anc_8bit_fill_checksum(AVSmpte291mAnc8bit *anc);

/**
 * Compute the sample count needed to encode a AVSmpte291mAnc8bit into a AVSmpte436mCodedAnc payload
 * @param[in] anc           The ANC packet.
 * @param[in] sample_coding The sample coding.
 * @param[in] log_ctx       context pointer for av_log
 * @return returns the sample count on success, otherwise < 0.
 */
int av_smpte_291m_anc_8bit_get_sample_count(const AVSmpte291mAnc8bit      *anc,
                                            AVSmpte436mPayloadSampleCoding sample_coding,
                                            void                          *log_ctx);

/**
 * Encode a AVSmpte291mAnc8bit into a AVSmpte436mCodedAnc
 * @param[in]  line_number   the line number the ANC packet is on
 * @param[in]  wrapping_type the wrapping type
 * @param[in]  sample_coding the payload sample coding
 * @param[in]  payload       the ANC packet to encode.
 * @param[in]  log_ctx       context pointer for av_log
 * @param[out] out           The encoded ANC packet.
 * @return returns 0 on success, otherwise < 0.
 */
int av_smpte_291m_anc_8bit_encode(AVSmpte436mCodedAnc           *out,
                                  uint16_t                       line_number,
                                  AVSmpte436mWrappingType        wrapping_type,
                                  AVSmpte436mPayloadSampleCoding sample_coding,
                                  const AVSmpte291mAnc8bit      *payload,
                                  void                          *log_ctx);

/** AVSmpte291mAnc8bit::did when carrying CTA-708 data (for AV_CODEC_ID_EIA_608) */
#define AV_SMPTE_291M_ANC_DID_CTA_708 0x61

/** AVSmpte291mAnc8bit::sdid_or_dbn when carrying CTA-708 data (for AV_CODEC_ID_EIA_608) */
#define AV_SMPTE_291M_ANC_SDID_CTA_708 0x1

/**
 * Try to decode an ANC packet into EIA-608/CTA-708 data (AV_CODEC_ID_EIA_608). This
 * @param[in]  anc     The ANC packet.
 * @param[in]  log_ctx Context pointer for av_log
 * @param[out] cc_data the buffer to store the extracted EIA-608/CTA-708 data,
 *                     you can pass NULL to not store the data.
 *                     the required size is 3 * cc_count bytes.
 *                     SMPTE_291M_ANC_PAYLOAD_CAPACITY is always enough size.
 * @return returns cc_count (>= 0) on success, AVERROR(EAGAIN) if it wasn't a CTA-708 ANC packet, < 0 on error.
 */
int av_smpte_291m_anc_8bit_extract_cta_708(const AVSmpte291mAnc8bit *anc, uint8_t *cc_data, void *log_ctx);

#endif /* AVCODEC_SMPTE_436M_H */
